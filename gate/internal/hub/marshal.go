package hub

import (
	"google.golang.org/protobuf/proto"

	pb "meter/gate/internal/pb"
)

// protoMarshal 是 proto.Marshal 的薄包装，省得每个调用点都写 err 检查。
func protoMarshal(m proto.Message) ([]byte, error) { return proto.Marshal(m) }

func mustMarshal(m proto.Message) []byte {
	b, err := proto.Marshal(m)
	if err != nil {
		panic(err) // 只用于我们自己构造的消息，编码失败是程序 bug
	}
	return b
}

// unmarshalBody 把 Envelope.body 解到具体消息里；失败计数并返回 false。
func (h *Hub) unmarshalBody(env *pb.Envelope, m proto.Message) bool {
	if err := proto.Unmarshal(env.GetBody(), m); err != nil {
		h.stats.badEnvelope.Add(1)
		return false
	}
	return true
}

// errorOf 把 RESPONSE 的 status+body 还原成 ErrorCode（status=0 时返回 nil）。
func errorOf(status uint32, body []byte) *pb.ErrorCode {
	if status == 0 {
		return nil
	}
	var e pb.ErrorCode
	if err := proto.Unmarshal(body, &e); err != nil {
		return &pb.ErrorCode{Code: int32(status)}
	}
	return &e
}

// badEnvelope 计一次"解不开的信封/oneof"。
func (h *Hub) unknownClient() {
	h.stats.unknownClient.Add(1)
}

func (h *Hub) badEnvelope() {
	h.stats.badEnvelope.Add(1)
}

// marshalUplinkMember 把 ClientUplink 的某个成员重新序列化为**裸的业务消息字节**。
// Login/Reconnect 转发给逻辑层时，逻辑层只需要 Login 本身（不需要外层 ClientUplink 包装），
// 所以这里从 uplink oneof 里取出成员对象再编码一次。
func marshalUplinkMember(up *pb.ClientUplink, env *pb.Envelope) []byte {
	switch body := up.GetBody().(type) {
	case *pb.ClientUplink_Login:
		b, err := proto.Marshal(body.Login)
		if err == nil {
			return b
		}
	case *pb.ClientUplink_Reconnect:
		b, err := proto.Marshal(body.Reconnect)
		if err == nil {
			return b
		}
	}
	// 兜底：原样（调用方应保证传进来的是 Login 或 Reconnect）
	return env.GetBody()
}
