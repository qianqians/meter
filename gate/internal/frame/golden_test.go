package frame

import (
	"encoding/hex"
	"testing"
)

// 与 TS 侧（core/src/frame.ts）逐字节一致的黄金向量。
// 值来自 `encodeFrame({ flags: 0, ts: 123456, payload: [9,8,7] })` 的输出。
func TestGoldenMatchesTSSide(t *testing.T) {
	const want = "0003000040e20100090807"
	raw, err := Encode(Frame{Flags: 0, TS: 123456, Payload: []byte{9, 8, 7}})
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(raw); got != want {
		t.Fatalf("与 TS 不一致\n got %s\nwant %s", got, want)
	}
}
