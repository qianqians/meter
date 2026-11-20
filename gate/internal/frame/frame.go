// 8 字节帧头编解码（规格见 docs/protocol-map.md §4.2–§4.5），与 core/src/frame.ts 逐字节一致。
//
//	off  size  field
//	0    1     flags   bit0 = zstd；bit1-7 必须为 0（未知位 → 报错）
//	1    3     len     payload 字节数（u24 LE，硬上限 1 MB）
//	4    4     ts      发送时刻（u32 LE，单调毫秒）
//	8    ...   payload
//
// 这里只做"分帧 + 校验"，不做压缩（压缩按 flags 在传输层决定）。
package frame

import "fmt"

const (
	HeaderSize = 8
	MaxPayload = 1 << 20 // 1 MB
	FlagZstd   = uint8(0b0001)
	knownFlags = FlagZstd
)

// Frame 是一帧的视图。Decode 回调里拿到的 Payload 指向调用方的缓冲区，**不要长期持有**。
type Frame struct {
	Flags   uint8
	TS      uint32
	Payload []byte
}

// Error 是帧层错误。gate 遇到它应该直接断开连接（语义已不可信）。
type Error struct {
	Code string // BAD_FLAGS / PAYLOAD_TOO_LARGE
	Msg  string
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Msg) }

// Encode 编码一帧。ts 由调用方给（通常是本进程单调钟的低 32 位）。
func Encode(f Frame) ([]byte, error) {
	if f.Flags&^knownFlags != 0 {
		return nil, &Error{"BAD_FLAGS", fmt.Sprintf("未知 flags 位: 0b%b", f.Flags)}
	}
	if len(f.Payload) > MaxPayload {
		return nil, &Error{"PAYLOAD_TOO_LARGE", fmt.Sprintf("%d 字节", len(f.Payload))}
	}
	out := make([]byte, HeaderSize+len(f.Payload))
	out[0] = f.Flags
	n := uint32(len(f.Payload))
	out[1] = byte(n)
	out[2] = byte(n >> 8)
	out[3] = byte(n >> 16)
	out[4] = byte(f.TS)
	out[5] = byte(f.TS >> 8)
	out[6] = byte(f.TS >> 16)
	out[7] = byte(f.TS >> 24)
	copy(out[HeaderSize:], f.Payload)
	return out, nil
}

// Decode 从 buf 里切帧，每切出一帧调用一次 fn。
//
// 返回**已消费的字节数**：半包不报错，调用方把 buf[consumed:] 留到下次数据到来（TCP 的正常现象）。
// 只有语义错误（未知 flags 位、len 超上限）才返回 *Error。
func Decode(buf []byte, fn func(Frame)) (int, error) {
	off := 0
	for len(buf)-off >= HeaderSize {
		flags := buf[off]
		if flags&^knownFlags != 0 {
			return off, &Error{"BAD_FLAGS", fmt.Sprintf("未知 flags 位: 0b%b", flags)}
		}
		n := int(buf[off+1]) | int(buf[off+2])<<8 | int(buf[off+3])<<16
		if n > MaxPayload {
			return off, &Error{"PAYLOAD_TOO_LARGE", fmt.Sprintf("len=%d", n)}
		}
		if len(buf)-off < HeaderSize+n {
			break // 半包：等更多数据
		}
		ts := uint32(buf[off+4]) | uint32(buf[off+5])<<8 | uint32(buf[off+6])<<16 | uint32(buf[off+7])<<24
		fn(Frame{Flags: flags, TS: ts, Payload: buf[off+HeaderSize : off+HeaderSize+n]})
		off += HeaderSize + n
	}
	return off, nil
}

// OneWayDelayMs 计算该跳的单向延迟：接收方单调时间 − 帧里的 ts。
// 用有符号 32 位差值处理 49.7 天回绕；越界（负数 / > 60s）视为异常时钟，clamp 到边界并返回 suspect=true。
// 只做统计，**不参与任何业务或安全判定**（ts 由发送方给，可伪造）。
func OneWayDelayMs(recvTS, frameTS uint32) (ms int32, suspect bool) {
	d := int32(recvTS - frameTS) // Go 的 uint32 减法天然回绕，转 int32 即得符号差值
	switch {
	case d < 0:
		return 0, true
	case d > 60_000:
		return 60_000, true
	default:
		return d, false
	}
}
