// Local keystore adapter. Imported secrets arrive over stdin; only encrypted keys leave it.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/lunfardo314/proxima/ledger/base"
	"github.com/lunfardo314/proxima/util/keystore"
)

type request struct {
	ImportData  []byte             `json:"importData"`
	Action      string             `json:"action"`
	Password    string             `json:"password"`
	NewPassword string             `json:"newPassword"`
	Keystore    *keystore.Keystore `json:"keystore"`
}
type response struct {
	Keystore *keystore.Keystore `json:"keystore,omitempty"`
	HolderID string             `json:"holderId,omitempty"`
	Error    string             `json:"error,omitempty"`
}

// Errors must never echo file contents: text files can contain plaintext keys.
func decodeImport(data []byte) (string, error) {
	if len(data) == 0 || len(data) > 16384 {
		return "", errors.New("wallet file must contain 1 to 16384 bytes")
	}
	if len(data) >= 2 && ((data[0] == 0xff && data[1] == 0xfe) || (data[0] == 0xfe && data[1] == 0xff)) {
		if len(data)%2 != 0 {
			return "", errors.New("invalid UTF-16 text file")
		}
		var order binary.ByteOrder = binary.LittleEndian
		if data[0] == 0xfe {
			order = binary.BigEndian
		}
		words := make([]uint16, (len(data)-2)/2)
		defer clear(words)
		for i := range words {
			words[i] = order.Uint16(data[2+i*2:])
		}
		for i := 0; i < len(words); i++ {
			if words[i] >= 0xd800 && words[i] <= 0xdbff {
				if i+1 >= len(words) || words[i+1] < 0xdc00 || words[i+1] > 0xdfff {
					return "", errors.New("invalid UTF-16 text file")
				}
				i++
			} else if words[i] >= 0xdc00 && words[i] <= 0xdfff {
				return "", errors.New("invalid UTF-16 text file")
			}
		}
		runes := utf16.Decode(words)
		defer clear(runes)
		data = []byte(string(runes))
		defer clear(data)
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return "", errors.New("save the wallet text as UTF-8 or BOM-marked UTF-16")
	}
	text := strings.TrimSpace(strings.TrimPrefix(string(data), "\ufeff"))
	if text == "" {
		return "", errors.New("wallet text file is empty")
	}
	return text, nil
}

func cleanHex(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && ((s[0] == '\'' && s[len(s)-1] == '\'') || (s[0] == '"' && s[len(s)-1] == '"')) {
		s = s[1 : len(s)-1]
	}
	return strings.TrimPrefix(strings.ToLower(s), "0x")
}

func parseImport(data []byte) (*keystore.Keystore, error) {
	text, err := decodeImport(data)
	if err != nil {
		return nil, err
	}
	if strings.HasPrefix(text, "{") {
		var ks keystore.Keystore
		if json.Unmarshal([]byte(text), &ks) != nil {
			return nil, errors.New("invalid Proxima JSON keystore; file contents are not displayed")
		}
		if err := validStore(&ks); err != nil {
			return nil, err
		}
		return &ks, nil
	}
	fields := map[string]string{}
	raw := cleanHex(text)
	if len(raw) == 128 && !strings.ContainsAny(raw, "\r\n") {
		fields["private_key"] = raw
	} else {
		if b, err := hex.DecodeString(raw); err == nil && len(b) == 32 {
			clear(b)
			return nil, errors.New("a bare 64-character value might be a public address, not a seed; only for a known Ed25519 seed, use an explicit seed: label")
		}
		walletHeader := false
		for _, line := range strings.Split(text, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			sep := strings.IndexAny(line, ":=")
			if sep < 0 {
				return nil, errors.New("unsupported text format: use a 128-hex Ed25519 private key, private_key: HEX, seed: HEX, or an official JSON keystore")
			}
			name := strings.ReplaceAll(strings.ReplaceAll(strings.ToLower(strings.TrimSpace(line[:sep])), " ", "_"), "-", "_")
			value := strings.TrimSpace(line[sep+1:])
			if name == "wallet" && value == "" && !walletHeader {
				walletHeader = true
				continue
			}
			switch name {
			case "privatekey":
				name = "private_key"
			case "publickey":
				name = "public_key"
			case "ed25519_seed":
				name = "seed"
			case "address":
				name = "holder_id"
			}
			if name != "private_key" && name != "seed" && name != "public_key" && name != "holder_id" {
				return nil, errors.New("unsupported field in wallet text; use only private_key or seed, with optional public_key and holder_id")
			}
			if _, found := fields[name]; found {
				return nil, errors.New("duplicate field in wallet text")
			}
			if value == "" {
				return nil, errors.New("empty field in wallet text")
			}
			fields[name] = cleanHex(value)
		}
	}
	_, hasKey := fields["private_key"]
	_, hasSeed := fields["seed"]
	if hasKey == hasSeed {
		return nil, errors.New("wallet text must contain exactly one private_key or seed; a public address alone cannot restore a wallet")
	}
	var key ed25519.PrivateKey
	if hasSeed {
		seed, err := hex.DecodeString(fields["seed"])
		defer clear(seed)
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, errors.New("Ed25519 seed must be exactly 64 hexadecimal characters")
		}
		key = ed25519.NewKeyFromSeed(seed)
	} else {
		key, err = hex.DecodeString(fields["private_key"])
		if err != nil || len(key) != ed25519.PrivateKeySize {
			clear(key)
			return nil, errors.New("Ed25519 private key must be exactly 128 hexadecimal characters")
		}
	}
	defer clear(key)
	canonical := ed25519.NewKeyFromSeed(key.Seed())
	defer clear(canonical)
	if !bytes.Equal(key, canonical) {
		return nil, errors.New("private key seed and public key disagree")
	}
	pub := key.Public().(ed25519.PublicKey)
	hid := base.HolderIDFromPublicKey(base.SignatureTypeED25519, pub)
	holder := hex.EncodeToString(hid[:])
	if expected, ok := fields["public_key"]; ok && expected != hex.EncodeToString(pub) {
		return nil, errors.New("public key does not match imported private key")
	}
	if expected, ok := fields["holder_id"]; ok && strings.TrimPrefix(expected, "a/") != holder {
		return nil, errors.New("holder ID does not match imported private key")
	}
	return keystore.NewUnencrypted(keystore.KeyTypeED25519, key, pub, holder)
}

func validStore(ks *keystore.Keystore) error {
	if ks == nil || ks.Version != 1 || ks.KeyType != keystore.KeyTypeED25519 {
		return errors.New("unsupported keystore version or key type")
	}
	if len(ks.PublicKey) != 64 {
		return errors.New("invalid public key")
	}
	if ks.Crypto != nil {
		c := ks.Crypto
		p := c.KDFParams
		// Bound untrusted imports before calling the upstream KDF/GCM implementation.
		if c.Cipher != "aes-256-gcm" || c.KDF != "argon2id" || p.Time < 1 || p.Time > 10 || p.Memory < 8192 || p.Memory > 262144 || p.Threads < 1 || p.Threads > 8 {
			return errors.New("unsupported or unsafe encryption parameters")
		}
		for _, item := range []struct {
			value string
			size  int
		}{{p.Salt, 16}, {c.Nonce, 12}, {c.Ciphertext, 80}} {
			b, err := hex.DecodeString(item.value)
			if err != nil || len(b) != item.size {
				return errors.New("invalid encrypted keystore structure")
			}
		}
		if ks.PrivateKey != "" {
			return errors.New("ambiguous keystore contains plaintext and encrypted keys")
		}
	}
	return nil
}
func execute(r request) (response, error) {
	var key ed25519.PrivateKey
	var err error
	switch r.Action {
	case "create":
		_, key, err = ed25519.GenerateKey(rand.Reader)
	case "import", "verify":
		if r.ImportData != nil {
			defer clear(r.ImportData)
			if r.Action != "import" || r.Keystore != nil {
				return response{}, errors.New("ambiguous import request")
			}
			r.Keystore, err = parseImport(r.ImportData)
			if err != nil {
				return response{}, err
			}
		}
		if err = validStore(r.Keystore); err != nil {
			return response{}, err
		}
		key, err = r.Keystore.GetPrivateKey(r.Password)
	default:
		return response{}, errors.New("unsupported operation")
	}
	if err != nil {
		return response{}, err
	}
	defer clear(key)
	if len(key) != ed25519.PrivateKeySize {
		return response{}, errors.New("invalid private key size")
	}
	// Upstream checks the embedded public half. Also verify it against the seed.
	canonical := ed25519.NewKeyFromSeed(key.Seed())
	defer clear(canonical)
	if !bytes.Equal(canonical, key) {
		return response{}, errors.New("private key seed and public key disagree")
	}
	pub := key.Public().(ed25519.PublicKey)
	hid := base.HolderIDFromPublicKey(base.SignatureTypeED25519, pub)
	holder := hex.EncodeToString(hid[:])
	if r.Keystore != nil && r.Keystore.HolderID != "" && r.Keystore.HolderID != holder {
		return response{}, errors.New("holder ID does not match key")
	}
	if r.Action == "verify" {
		return response{HolderID: holder}, nil
	}
	if len(r.NewPassword) < 12 || len(r.NewPassword) > 1024 {
		return response{}, errors.New("use a password of 12 to 1024 bytes")
	}
	encrypted, err := keystore.Encrypt(keystore.KeyTypeED25519, key, pub, r.NewPassword, holder)
	return response{Keystore: encrypted, HolderID: holder}, err
}
func main() {
	// One bounded request, no network and no files. Avoid logging secret input.
	var r request
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 65537))
	if err != nil || len(data) > 65536 {
		fmt.Println(`{"error":"request too large"}`)
		return
	}
	err = json.Unmarshal(data, &r)
	clear(data)
	var result response
	if err == nil {
		result, err = execute(r)
	}
	if err != nil {
		result = response{Error: err.Error()}
	}
	_ = json.NewEncoder(os.Stdout).Encode(result)
}
