// S2：flatbuffer vs protobuf —— Go 侧实测（与 bench-ts.mjs 逐行对等）
//
// 同一份数据（N 个实体状态 + 10 个头字段），四种序列化，量 encode/build、decode/read、字节数。
//
// ⚠️ 与 TS 侧同样的两条公平性说明：
//  1. protobuf 必须先造消息结构体再 Marshal（这是它的模型）；FlatBuffers 直接从列式数据
//     写进 buffer（这是它的模型）。差异本身是结论的一部分。
//  2. protobuf 的 Unmarshal 会物化整个结构体树；FlatBuffers 的 GetRootAs 只是包一层，
//     成本在读字段时才付。所以"protobuf Unmarshal+读满"配"FlatBuffers wrap+读满"。
//
// ⚠️ 计时方法的坑（本机踩到了）：这台机器上 Go 的单调时钟对**微秒级区间**经常报 0 ns
//
//	（实测：一次 FlatBuffers wrap 的工作量就落在 0 的分辨率里）。所以这里
//	① 每个样本内批量跑 k 次再除以 k；② 批量后仍然全部为 0 的，如实标成"< LOD"，
//	不做"1 ns"之类的伪造。
//
// 运行：go run ./bench-go [实体数] [重复次数]
package main

import (
	"fmt"
	"os"
	"strconv"
	"time"

	flatbuffers "github.com/google/flatbuffers/go"
	"google.golang.org/protobuf/proto"

	"s2bench/gen/go/s2"
	"s2bench/schema"
)

var sink uint64

// 返回每次迭代的 ns（浮点，避免 sample/k 整除成 0）；ok=false 表示低于本机时钟分辨率
func measure(k int, reps int, fn func()) (float64, bool) {
	fn()
	fn()
	sample := int64(1<<62 - 1)
	for r := 0; r < reps; r++ {
		t0 := time.Now()
		for i := 0; i < k; i++ {
			fn()
		}
		if dt := time.Since(t0).Nanoseconds(); dt > 0 && dt < sample {
			sample = dt
		}
	}
	if sample == int64(1<<62-1) {
		return 0, false
	}
	return float64(sample) / float64(k), true
}

var (
	n    = 1000
	reps = 100

	id, kind, dir, level, faction, stateFlags []uint32
	x, y, z, vx, vy, hp, hpMax, mp            []int32
	buffMask                                  []uint64
)

const (
	hTick     = 123456
	hSeq      = 98765
	hSceneID  = 42
	hPlayerID = uint64(9007199254740993)
	hSvrTime  = uint64(1795000000000)
	hAckTick  = 123400
	hAckSeq   = 98700
	hProtoVer = 3
	hFlags    = 0x1f
	hChecksum = 0xdeadbeef
)

func initData() {
	id = make([]uint32, n)
	kind = make([]uint32, n)
	x = make([]int32, n)
	y = make([]int32, n)
	z = make([]int32, n)
	vx = make([]int32, n)
	vy = make([]int32, n)
	dir = make([]uint32, n)
	hp = make([]int32, n)
	hpMax = make([]int32, n)
	mp = make([]int32, n)
	level = make([]uint32, n)
	faction = make([]uint32, n)
	stateFlags = make([]uint32, n)
	buffMask = make([]uint64, n)

	// 与 bench-ts.mjs 完全同一套确定性公式（不用 LCG，免得两门语言的浮点/位宽差异导致数据不同）
	for i := 0; i < n; i++ {
		k := uint64(i)
		id[i] = uint32(1000000 + i)
		kind[i] = uint32(i%7 + 1)
		x[i] = int32((k*7919)%200000) - 100000
		y[i] = int32((k*104729+31)%200000) - 100000
		z[i] = int32((k*37)%4000) - 2000
		vx[i] = int32((k*13)%800) - 400
		vy[i] = int32((k*17+5)%800) - 400
		dir[i] = uint32((k * 29) % 360)
		hp[i] = int32(1000 + (k*61)%9000)
		hpMax[i] = 10000
		mp[i] = int32((k * 23) % 500)
		level[i] = uint32(1 + i%80)
		faction[i] = uint32(i & 3)
		stateFlags[i] = uint32((k * 8191) % 65536)
		buffMask[i] = ((k*2654435761)&0xffffffff)*4 + uint64(i&3)
	}
}

// ---------- 1. protobuf AoS ----------
func pbAosEncode() []byte {
	ents := make([]*schema.EntityState, n)
	for i := 0; i < n; i++ {
		ents[i] = &schema.EntityState{
			Id: id[i], Kind: kind[i], X: x[i], Y: y[i], Z: z[i], Vx: vx[i], Vy: vy[i], Dir: dir[i],
			Hp: hp[i], HpMax: hpMax[i], Mp: mp[i], Level: level[i], Faction: faction[i],
			StateFlags: stateFlags[i], BuffMask: buffMask[i],
		}
	}
	buf, err := proto.Marshal(&schema.StatePacket{
		Tick: hTick, Seq: hSeq, SceneId: hSceneID, PlayerId: hPlayerID, SvrTimeMs: hSvrTime,
		AckTick: hAckTick, AckSeq: hAckSeq, ProtoVer: hProtoVer, Flags: hFlags, Checksum: hChecksum,
		Entities: ents,
	})
	if err != nil {
		panic(err)
	}
	return buf
}

func pbAosDecodeRead(buf []byte) {
	var m schema.StatePacket
	if err := proto.Unmarshal(buf, &m); err != nil {
		panic(err)
	}
	var s uint64
	for _, e := range m.Entities {
		s += uint64(e.Id) + uint64(e.X) + uint64(e.Hp) + uint64(e.StateFlags) + e.BuffMask
	}
	sink += s
}

// ---------- 2. FlatBuffers AoS（struct 数组） ----------
func fbAosBuild() []byte {
	b := flatbuffers.NewBuilder(1024 + n*64 + 256)
	s2.StatePacketStartEntitiesVector(b, n)
	for i := 0; i < n; i++ {
		s2.CreateEntityState(b, id[i], kind[i], x[i], y[i], z[i], vx[i], vy[i], dir[i],
			hp[i], hpMax[i], mp[i], level[i], faction[i], stateFlags[i], buffMask[i])
	}
	vec := b.EndVector(n)
	s2.StatePacketStart(b)
	s2.StatePacketAddTick(b, hTick)
	s2.StatePacketAddSeq(b, hSeq)
	s2.StatePacketAddSceneId(b, hSceneID)
	s2.StatePacketAddPlayerId(b, hPlayerID)
	s2.StatePacketAddSvrTimeMs(b, hSvrTime)
	s2.StatePacketAddAckTick(b, hAckTick)
	s2.StatePacketAddAckSeq(b, hAckSeq)
	s2.StatePacketAddProtoVer(b, hProtoVer)
	s2.StatePacketAddFlags(b, hFlags)
	s2.StatePacketAddChecksum(b, hChecksum)
	s2.StatePacketAddEntities(b, vec)
	pkt := s2.StatePacketEnd(b)
	b.Finish(pkt)
	out := make([]byte, len(b.FinishedBytes()))
	copy(out, b.FinishedBytes())
	return out
}

func fbAosWrap(buf []byte) *s2.StatePacket { return s2.GetRootAsStatePacket(buf, 0) }

func fbAosReadAll(p *s2.StatePacket) {
	e := &s2.EntityState{}
	var s uint64
	cnt := p.EntitiesLength()
	for i := 0; i < cnt; i++ {
		if p.Entities(e, i) {
			s += uint64(e.Id()) + uint64(int64(e.X())) + uint64(int64(e.Hp())) + uint64(e.StateFlags()) + e.BuffMask()
		}
	}
	sink += s
}

// ---------- 3. protobuf SoA（packed 数组） ----------
func pbSoaEncode() []byte {
	u32 := func(v []uint32) []uint32 { c := make([]uint32, n); copy(c, v); return c }
	i32 := func(v []int32) []int32 { c := make([]int32, n); copy(c, v); return c }
	buf, err := proto.Marshal(&schema.StatePacketSoA{
		Tick: hTick, Seq: hSeq, SceneId: hSceneID, PlayerId: hPlayerID, SvrTimeMs: hSvrTime,
		AckTick: hAckTick, AckSeq: hAckSeq, ProtoVer: hProtoVer, Flags: hFlags, Checksum: hChecksum,
		Id: u32(id), Kind: u32(kind), X: i32(x), Y: i32(y), Z: i32(z), Vx: i32(vx), Vy: i32(vy),
		Dir: u32(dir), Hp: i32(hp), HpMax: i32(hpMax), Mp: i32(mp), Level: u32(level),
		Faction: u32(faction), StateFlags: u32(stateFlags), BuffMask: buffMask,
	})
	if err != nil {
		panic(err)
	}
	return buf
}

func pbSoaDecodeRead(buf []byte) {
	var m schema.StatePacketSoA
	if err := proto.Unmarshal(buf, &m); err != nil {
		panic(err)
	}
	var s uint64
	for i := range m.Id {
		s += uint64(m.Id[i]) + uint64(int64(m.X[i])) + uint64(int64(m.Hp[i])) + uint64(m.StateFlags[i]) + m.BuffMask[i]
	}
	sink += s
}

// ---------- 4. FlatBuffers SoA（字段 vector） ----------
func u32Vec(b *flatbuffers.Builder, v []uint32) flatbuffers.UOffsetT {
	b.StartVector(4, len(v), 4)
	for i := len(v) - 1; i >= 0; i-- {
		b.PrependUint32(v[i])
	}
	return b.EndVector(len(v))
}

func i32Vec(b *flatbuffers.Builder, v []int32) flatbuffers.UOffsetT {
	b.StartVector(4, len(v), 4)
	for i := len(v) - 1; i >= 0; i-- {
		b.PrependInt32(v[i])
	}
	return b.EndVector(len(v))
}

func fbSoaBuild() []byte {
	b := flatbuffers.NewBuilder(1024 + n*64 + 256)
	vid, vkind := u32Vec(b, id), u32Vec(b, kind)
	vx0, vy0, vz0 := i32Vec(b, x), i32Vec(b, y), i32Vec(b, z)
	vvx, vvy := i32Vec(b, vx), i32Vec(b, vy)
	vdir := u32Vec(b, dir)
	vhp, vhpMax, vmp := i32Vec(b, hp), i32Vec(b, hpMax), i32Vec(b, mp)
	vlevel, vfaction, vflags := u32Vec(b, level), u32Vec(b, faction), u32Vec(b, stateFlags)

	b.StartVector(8, n, 8)
	for i := n - 1; i >= 0; i-- {
		b.PrependUint64(buffMask[i])
	}
	vbuff := b.EndVector(n)

	s2.StatePacketSoAStart(b)
	s2.StatePacketSoAAddTick(b, hTick)
	s2.StatePacketSoAAddSeq(b, hSeq)
	s2.StatePacketSoAAddSceneId(b, hSceneID)
	s2.StatePacketSoAAddPlayerId(b, hPlayerID)
	s2.StatePacketSoAAddSvrTimeMs(b, hSvrTime)
	s2.StatePacketSoAAddAckTick(b, hAckTick)
	s2.StatePacketSoAAddAckSeq(b, hAckSeq)
	s2.StatePacketSoAAddProtoVer(b, hProtoVer)
	s2.StatePacketSoAAddFlags(b, hFlags)
	s2.StatePacketSoAAddChecksum(b, hChecksum)
	s2.StatePacketSoAAddId(b, vid)
	s2.StatePacketSoAAddKind(b, vkind)
	s2.StatePacketSoAAddX(b, vx0)
	s2.StatePacketSoAAddY(b, vy0)
	s2.StatePacketSoAAddZ(b, vz0)
	s2.StatePacketSoAAddVx(b, vvx)
	s2.StatePacketSoAAddVy(b, vvy)
	s2.StatePacketSoAAddDir(b, vdir)
	s2.StatePacketSoAAddHp(b, vhp)
	s2.StatePacketSoAAddHpMax(b, vhpMax)
	s2.StatePacketSoAAddMp(b, vmp)
	s2.StatePacketSoAAddLevel(b, vlevel)
	s2.StatePacketSoAAddFaction(b, vfaction)
	s2.StatePacketSoAAddStateFlags(b, vflags)
	s2.StatePacketSoAAddBuffMask(b, vbuff)
	pkt := s2.StatePacketSoAEnd(b)
	b.Finish(pkt)
	out := make([]byte, len(b.FinishedBytes()))
	copy(out, b.FinishedBytes())
	return out
}

func fbSoaWrap(buf []byte) *s2.StatePacketSoA { return s2.GetRootAsStatePacketSoA(buf, 0) }

func fbSoaReadAll(p *s2.StatePacketSoA) {
	var s uint64
	cnt := p.IdLength()
	for i := 0; i < cnt; i++ {
		s += uint64(p.Id(i)) + uint64(int64(p.X(i))) + uint64(int64(p.Hp(i))) + uint64(p.StateFlags(i)) + p.BuffMask(i)
	}
	sink += s
}

type row struct {
	name            string
	encUs, bytes    float64
	decUs, readUs   float64
	hasDec, hasRead bool
	perEntityNs     float64
	hasPerEntity    bool
}

func fmtUs(us float64, ok bool) string {
	if !ok {
		return "<LOD"
	}
	return fmt.Sprintf("%.1f", us)
}

func main() {
	if len(os.Args) > 1 {
		n, _ = strconv.Atoi(os.Args[1])
	}
	if len(os.Args) > 2 {
		reps, _ = strconv.Atoi(os.Args[2])
	}
	initData()

	// 时钟自检：本机的 Go 单调时钟对很短的区间会报 0，所以先确认 20 ms 能测出来
	tSelf := time.Now()
	time.Sleep(20 * time.Millisecond)
	fmt.Printf("go  实体数=%d 重复=%d（取最快样本）  时钟自检 sleep(20ms)=%.2fms\n\n",
		n, reps, float64(time.Since(tSelf).Nanoseconds())/1e6)

	const (
		kEnc  = 200 // ≈ 87 µs/次 → 单样本 ~17 ms
		kRead = 400 // ≈ 50 µs/次 → 单样本 ~20 ms
		kWrap = 50000
	)

	var rows []row
	add := func(name string, build func() []byte, decodeOnly func([]byte), read func([]byte)) {
		encNs, okEnc := measure(kEnc, reps, func() { sink += uint64(len(build())) })
		buf := build()
		r := row{name: name, bytes: float64(len(buf))}
		if okEnc {
			r.encUs = encNs / 1000
		}
		r.hasDec = true
		if decodeOnly != nil {
			ns, ok := measure(kWrap, reps, func() { decodeOnly(buf) })
			r.decUs, r.hasDec = ns/1000, ok
		} else {
			r.hasDec = false
		}
		ns, ok := measure(kRead, reps, func() { read(buf) })
		r.readUs, r.hasRead = ns/1000, ok
		if ok {
			r.perEntityNs, r.hasPerEntity = ns/float64(n), true
		}
		rows = append(rows, r)
	}

	add("protobuf AoS", pbAosEncode, nil, pbAosDecodeRead)
	add("FlatBuffers AoS（struct 数组）", fbAosBuild,
		func(buf []byte) { sink += uint64(len(fbAosWrap(buf).Table().Bytes)) },
		func(buf []byte) { fbAosReadAll(fbAosWrap(buf)) })
	add("protobuf SoA（packed 数组）", pbSoaEncode, nil, pbSoaDecodeRead)
	add("FlatBuffers SoA（字段 vector）", fbSoaBuild,
		func(buf []byte) { sink += uint64(len(fbSoaWrap(buf).Table().Bytes)) },
		func(buf []byte) { fbSoaReadAll(fbSoaWrap(buf)) })

	fmt.Printf("%-30s%11s%9s%11s%10s%16s%13s\n", "实现", "encode µs", "bytes", "每实体 B", "wrap µs", "read+decode µs", "每实体 ns")
	for _, r := range rows {
		encCol := "<LOD"
		if r.encUs > 0 {
			encCol = fmt.Sprintf("%.1f", r.encUs)
		}
		wrapCol := "—"
		if r.hasDec {
			wrapCol = fmtUs(r.decUs, r.hasDec && r.decUs > 0)
		}
		perEnt := "<LOD"
		if r.hasPerEntity {
			perEnt = fmt.Sprintf("%.0f", r.perEntityNs)
		}
		fmt.Printf("%-30s%11s%9.0f%11.1f%10s%16s%13s\n",
			r.name, encCol, r.bytes, r.bytes/float64(n), wrapCol, fmtUs(r.readUs, r.hasRead), perEnt)
	}
	fmt.Printf("\n(LOD = 低于本机 Go 时钟分辨率; sink=%d)\n", sink)
}
