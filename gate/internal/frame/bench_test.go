package frame

import "testing"

var payload64 = make([]byte, 64)

func BenchmarkEncode(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = Encode(Frame{TS: 1, Payload: payload64})
	}
}

func BenchmarkDecode(b *testing.B) {
	buf, _ := Encode(Frame{TS: 1, Payload: payload64})
	sink := 0
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = Decode(buf, func(f Frame) { sink += len(f.Payload) })
	}
	_ = sink
}
