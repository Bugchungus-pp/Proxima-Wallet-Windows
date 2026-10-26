package main

import (
	"crypto/ed25519"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestCreateImportVerify(t *testing.T) {
	r, err := execute(request{Action: "create", NewPassword: "a long test password"})
	if err != nil {
		t.Fatal(err)
	}
	if r.Keystore.PrivateKey != "" || r.Keystore.Crypto == nil || len(r.HolderID) != 64 {
		t.Fatal("not encrypted")
	}
	v, err := execute(request{Action: "verify", Password: "a long test password", Keystore: r.Keystore})
	if err != nil || v.HolderID != r.HolderID {
		t.Fatal("cannot unlock", err)
	}
	if _, err = execute(request{Action: "verify", Password: "wrong", Keystore: r.Keystore}); err == nil {
		t.Fatal("wrong password accepted")
	}
	imported, err := execute(request{Action: "import", Password: "a long test password", NewPassword: "a different password", Keystore: r.Keystore})
	if err != nil || imported.HolderID != r.HolderID {
		t.Fatal("import failed", err)
	}
	if _, err = execute(request{Action: "verify", Password: "a different password", Keystore: imported.Keystore}); err != nil {
		t.Fatal(err)
	}
	r.Keystore.HolderID = "bad"
	if _, err = execute(request{Action: "verify", Password: "a long test password", Keystore: r.Keystore}); err == nil {
		t.Fatal("mismatch accepted")
	}
}
func TestMalformedKeystores(t *testing.T) {
	r, _ := execute(request{Action: "create", NewPassword: "a long test password"})
	encoded, _ := json.Marshal(r.Keystore)
	for _, mutation := range []string{"nonce", "memory", "threads", "cipher", "plaintext"} {
		var req request
		req.Action = "verify"
		req.Password = "a long test password"
		_ = json.Unmarshal(encoded, &req.Keystore)
		switch mutation {
		case "nonce":
			req.Keystore.Crypto.Nonce = "00"
		case "memory":
			req.Keystore.Crypto.KDFParams.Memory = 4294967295
		case "threads":
			req.Keystore.Crypto.KDFParams.Threads = 0
		case "cipher":
			req.Keystore.Crypto.Cipher = "unknown"
		case "plaintext":
			req.Keystore.PrivateKey = "bad"
		}
		if _, err := execute(req); err == nil {
			t.Fatal("accepted", mutation)
		}
	}
}
func TestPasswordPolicy(t *testing.T) {
	if _, err := execute(request{Action: "create", NewPassword: "short"}); err == nil {
		t.Fatal("short password accepted")
	}
}

func utf16File(text string, big bool) []byte {
	var order binary.ByteOrder = binary.LittleEndian
	data := []byte{0xff, 0xfe}
	if big {
		order = binary.BigEndian
		data = []byte{0xfe, 0xff}
	}
	for _, w := range utf16.Encode([]rune(text)) {
		var b [2]byte
		order.PutUint16(b[:], w)
		data = append(data, b[:]...)
	}
	return data
}

func TestTextImportEncodingsAndFormats(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	key := ed25519.NewKeyFromSeed(seed)
	hexKey := hex.EncodeToString(key)
	forms := map[string][]byte{
		"raw":      []byte(hexKey),
		"utf8-bom": []byte("\ufeff" + strings.ToUpper(hexKey) + "\r\n"),
		"label":    []byte("# exported wallet\r\nwallet:\r\n  private_key: '0x" + hexKey + "'\r\n"),
		"equals":   []byte("Private Key = " + hexKey),
		"seed":     []byte("seed: " + hex.EncodeToString(seed)),
		"utf16-le": utf16File("private_key: "+hexKey+"\r\n", false),
		"utf16-be": utf16File(hexKey, true),
	}
	for name, data := range forms {
		t.Run(name, func(t *testing.T) {
			ks, err := parseImport(data)
			if err != nil {
				t.Fatal(err)
			}
			got, err := ks.GetPrivateKey("")
			if err != nil || hex.EncodeToString(got) != hexKey {
				t.Fatal("import changed the key", err)
			}
		})
	}
	ks, err := parseImport([]byte(hexKey))
	if err != nil {
		t.Fatal(err)
	}
	metadata := "private_key: " + hexKey + "\npublic_key: " + ks.PublicKey + "\nholder_id: a/" + ks.HolderID
	if _, err := parseImport([]byte(metadata)); err != nil {
		t.Fatal(err)
	}
}

func TestTextImportRejectsAmbiguousAndMalformedFiles(t *testing.T) {
	key := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	hexKey := hex.EncodeToString(key)
	inputs := [][]byte{
		nil, []byte(" "), []byte(strings.Repeat("x", 16385)), []byte{0xff},
		[]byte{0xff, 0xfe, 0x00}, []byte{0xff, 0xfe, 0x00, 0xd8}, []byte("seed:\x00"),
		[]byte(strings.Repeat("ab", 32)), []byte("a/" + strings.Repeat("ab", 32)),
		[]byte("public_key: " + strings.Repeat("ab", 32)),
		[]byte("private_key: 00"), []byte("seed: 00"), []byte(strings.Repeat("ab", 64)),
		[]byte("private_key: " + hexKey + "\nseed: " + strings.Repeat("ab", 32)),
		[]byte("private_key: " + hexKey + "\nprivate_key: " + hexKey),
		[]byte("private_key: " + hexKey + "\npublic_key: " + strings.Repeat("ab", 32)),
		[]byte("private_key: " + hexKey + "\naddress: " + strings.Repeat("ab", 32)),
		[]byte("private_key: " + hexKey + "\nunknown: do-not-echo-this"),
		[]byte("{invalid-json:" + hexKey),
	}
	for i, data := range inputs {
		_, err := parseImport(data)
		if err == nil {
			t.Fatalf("accepted invalid case %d", i)
		}
		if strings.Contains(err.Error(), hexKey) || strings.Contains(err.Error(), "do-not-echo-this") {
			t.Fatal("secret leaked in error")
		}
	}
}

func TestFileImportEncryptsAndPreservesIdentity(t *testing.T) {
	created, err := execute(request{Action: "create", NewPassword: "original test password"})
	if err != nil {
		t.Fatal(err)
	}
	jsonData, _ := json.Marshal(created.Keystore)
	plain, err := created.Keystore.GetPrivateKey("original test password")
	if err != nil {
		t.Fatal(err)
	}
	for _, data := range [][]byte{jsonData, append([]byte("\ufeff"), jsonData...), utf16File(string(jsonData), false), []byte(hex.EncodeToString(plain))} {
		// execute zeroes the input buffer; preserve the fixture for later cases.
		imported, err := execute(request{Action: "import", ImportData: append([]byte(nil), data...), Password: "original test password", NewPassword: "replacement test password"})
		if err != nil {
			t.Fatal(err)
		}
		if imported.HolderID != created.HolderID || imported.Keystore.PrivateKey != "" || imported.Keystore.Crypto == nil {
			t.Fatal("identity/encryption failure")
		}
		verified, err := execute(request{Action: "verify", Keystore: imported.Keystore, Password: "replacement test password"})
		if err != nil || verified.HolderID != created.HolderID {
			t.Fatal("cannot unlock import", err)
		}
	}
	if _, err := execute(request{Action: "import", ImportData: jsonData, Password: "wrong", NewPassword: "replacement test password"}); err == nil {
		t.Fatal("accepted wrong password")
	}
	if _, err := execute(request{Action: "import", ImportData: []byte("seed: 00"), Keystore: created.Keystore}); err == nil {
		t.Fatal("accepted ambiguous request")
	}
}
