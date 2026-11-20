package frame

import (
	"bytes"
	"testing"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	raw, err := Encode(Frame{Flags: 0, TS: 123456, Payload: []byte{9, 8, 7}})
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != HeaderSize+3 {
		t.Fatalf("长度应为 8+3，实际 %d", len(raw))
	}
	var got []Frame
	consumed, err := Decode(raw, func(f Frame) { got = append(got, Frame{f.Flags, f.TS, append([]byte(nil), f.Payload...)}) })
	if err != nil {
		t.Fatal(err)
	}
	if consumed != len(raw) || len(got) != 1 {
		t.Fatalf("consumed=%d frames=%d", consumed, len(got))
	}
	if got[0].TS != 123456 || !bytes.Equal(got[0].Payload, []byte{9, 8, 7}) {
		t.Fatalf("往返不一致: %+v", got[0])
	}
}

func TestDecodePartialFrameWaits(t *testing.T) {
	f1, _ := Encode(Frame{TS: 1, Payload: []byte{1, 2}})
	f2, _ := Encode(Frame{TS: 2, Payload: []byte{3, 4}})
	all := append(append([]byte{}, f1...), f2...)

	var got []Frame
	consumed, err := Decode(all[:len(f1)+3], func(f Frame) { got = append(got, f) })
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || consumed != len(f1) {
		t.Fatalf("半包应只消费第一帧: got=%d consumed=%d", len(got), consumed)
	}

	rest := all[consumed:]
	if _, err := Decode(rest, func(f Frame) { got = append(got, f) }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("补上后半包后应有 2 帧，实际 %d", len(got))
	}
}

func TestUnknownFlagsRejected(t *testing.T) {
	if _, err := Encode(Frame{Flags: 0b100}); err == nil {
		t.Fatal("编码时应拒绝未知 flags 位")
	}
	bad := make([]byte, HeaderSize)
	bad[0] = 0b10
	if _, err := Decode(bad, func(Frame) {}); err == nil {
		t.Fatal("解码时应拒绝未知 flags 位")
	} else if e, ok := err.(*Error); !ok || e.Code != "BAD_FLAGS" {
		t.Fatalf("错误码应为 BAD_FLAGS，实际 %v", err)
	}
}

func TestPayloadTooLarge(t *testing.T) {
	if _, err := Encode(Frame{Payload: make([]byte, MaxPayload+1)}); err == nil {
		t.Fatal("应拒绝超过 1 MB 的 payload")
	}
}

func TestOneWayDelayWrapsAt32Bits(t *testing.T) {
	cases := []struct {
		recv, ts uint32
		want     int32
		suspect  bool
	}{
		{1007, 1000, 7, false},        // 正常
		{0x10, 0xfffffff0, 32, false}, // 跨 32 位回绕：应算 32 ms
		{0, 30000, 0, true},           // 客户端快 30 s：clamp 到 0
		{7_200_000, 0, 60000, true},   // 慢 2 小时：clamp 到 60 s
	}
	for _, c := range cases {
		got, suspect := OneWayDelayMs(c.recv, c.ts)
		if got != c.want || suspect != c.suspect {
			t.Fatalf("OneWayDelayMs(%d,%d)=(%d,%v)，期望 (%d,%v)", c.recv, c.ts, got, suspect, c.want, c.suspect)
		}
	}
}
