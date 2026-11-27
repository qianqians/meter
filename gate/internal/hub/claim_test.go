package hub

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/protobuf/proto"

	pb "meter/gate/internal/pb"
	"meter/gate/internal/session"
	"meter/gate/internal/sessiondir"
)

type fakeDir struct {
	prev     *sessiondir.Entry
	claimErr error
	claims   []sessiondir.Entry
	released []string
	refreshN int
}

func (f *fakeDir) Claim(_ context.Context, userID string, e sessiondir.Entry) (*sessiondir.Entry, uint64, error) {
	if f.claimErr != nil {
		return nil, 0, f.claimErr
	}
	f.claims = append(f.claims, e)
	return f.prev, 7, nil
}

func (f *fakeDir) Refresh(context.Context, string, string, string) (bool, error) {
	f.refreshN++
	return true, nil
}

func (f *fakeDir) Release(_ context.Context, userID, gate, conn string) (bool, error) {
	f.released = append(f.released, userID+"@"+gate+"/"+conn)
	return true, nil
}

func claimReq(t *testing.T, nodeID string, m *pb.HubClaimUser) *pb.Envelope {
	t.Helper()
	return &pb.Envelope{MsgType: pb.MsgType_MSG_REQUEST, Method: "hub.claimUser", CallbackId: 3, Body: mustBody(t, m)}
}

// 未启用目录：照常回一个空的 GateOwnerInfo（status=0），逻辑层据此正常登录、不做跨节点接管
func TestClaimUserWithoutDirectory(t *testing.T) {
	h, _ := newHub()
	logic := &fakePeer{}
	h.AddLogic("n1", logic)

	h.OnLogic("n1", claimReq(t, "n1", &pb.HubClaimUser{UserId: "u1", EntityId: "e1", ConnId: "c1"}))

	env := logic.last()
	if env.GetMethod() != "gate.ownerInfo" || env.GetMsgType() != pb.MsgType_MSG_RESPONSE || env.GetCallbackId() != 3 {
		t.Fatalf("回包形状不对: %+v", env)
	}
	if env.GetStatus() != 0 {
		t.Fatalf("未启用目录不该失败: %d", env.GetStatus())
	}
	var info pb.GateOwnerInfo
	if err := proto.Unmarshal(env.GetBody(), &info); err != nil {
		t.Fatal(err)
	}
	if info.GetNodeId() != "" {
		t.Fatalf("未启用目录时不应有归属: %+v", &info)
	}
}

// 启用目录：把占位写进去（node/gate/conn/entity），并把旧主人回给逻辑层
func TestClaimUserReturnsPreviousOwner(t *testing.T) {
	dir := &fakeDir{prev: &sessiondir.Entry{Node: "n-old", Gate: "g-old", Conn: "c-old", Entity: "e-old", Seq: 4}}
	h := New(session.New(), func() uint32 { return 1 }, "g-now", nil, Options{Dir: dir})
	logic := &fakePeer{}
	h.AddLogic("n1", logic)

	h.OnLogic("n1", claimReq(t, "n1", &pb.HubClaimUser{UserId: "u1", EntityId: "e1", ConnId: "c1"}))

	if len(dir.claims) != 1 {
		t.Fatalf("应占位一次: %+v", dir.claims)
	}
	if got := dir.claims[0]; got.Node != "n1" || got.Gate != "g-now" || got.Conn != "c1" || got.Entity != "e1" {
		t.Fatalf("占位内容不对: %+v", got)
	}

	var info pb.GateOwnerInfo
	if err := proto.Unmarshal(logic.last().GetBody(), &info); err != nil {
		t.Fatal(err)
	}
	if info.GetNodeId() != "n-old" || info.GetGateName() != "g-old" || info.GetConnId() != "c-old" || info.GetEntityId() != "e-old" {
		t.Fatalf("回给逻辑层的旧主人不对: %+v", &info)
	}
	if info.GetSeq() != 7 {
		t.Fatalf("seq 应是**新**会话的序号（逻辑层用它挡迟到的接管通知）: %d", info.GetSeq())
	}
}

// 目录故障：回 status=1 + 空 body，让逻辑层确定性地拒绝登录
func TestClaimUserDirectoryError(t *testing.T) {
	h := New(session.New(), func() uint32 { return 1 }, "g", nil, Options{Dir: &fakeDir{claimErr: errors.New("boom")}})
	logic := &fakePeer{}
	h.AddLogic("n1", logic)

	h.OnLogic("n1", claimReq(t, "n1", &pb.HubClaimUser{UserId: "u1"}))

	env := logic.last()
	if env.GetStatus() != 1 {
		t.Fatalf("目录故障应回 status=1: %+v", env)
	}
	if len(env.GetBody()) != 0 {
		t.Fatalf("失败时 body 应为空: %v", env.GetBody())
	}
}

// 连接断开：释放目录里的归属（带 gate+conn 比对，由 Dir 内部保证）
func TestRemoveClientReleasesDirectory(t *testing.T) {
	dir := &fakeDir{}
	h := New(session.New(), func() uint32 { return 1 }, "g1", nil, Options{Dir: dir})
	client := &fakePeer{}
	h.AddClient("c1", client)
	h.OnLogic("n1", &pb.Envelope{Method: "hub.createPlayerEntity",
		Body: mustBody(t, &pb.HubCreatePlayerEntity{ConnId: "c1", UserId: "u1", EntityId: "e1"})})

	h.RemoveClient("c1")
	if len(dir.released) != 1 || dir.released[0] != "u1@g1/c1" {
		t.Fatalf("断开时应释放目录记录: %+v", dir.released)
	}
}
