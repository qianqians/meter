// 跨 gate 共享的会话归属目录：「这个用户现在归哪台 gate 的哪个节点」。
//
// 为什么需要它：单台 gate 的内存会话表看不见别的 gate 上的连接。同账号换设备登录时，
// 新连接可能落在另一台 gate 上——只有共享存储能回答"旧会话在哪"，否则新节点既踢不掉
// 旧连接，也不知道旧实体还在跑（两个写者）。
//
// 键：session:{userId} → {node, gate, conn, entity, seq}
//
// 三条纪律（都靠 Lua 保证原子）：
//
//	· Claim  = 读旧值 + seq+1 + 写新值，一次完成；跨节点并发登录只有一个赢家拿到旧记录。
//	· Refresh/Release 都**带 gate+conn 比对**：迟到的旧连接既不能给新会话续命，也删不掉它。
//	· TTL：在线时由各 gate 周期性续期；gate 崩了记录自然过期，不会永久指向一个死节点。
package sessiondir

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Entry 是一条会话归属记录。
type Entry struct {
	Node   string `json:"node"`   // 逻辑节点 id
	Gate   string `json:"gate"`   // gate 名
	Conn   string `json:"conn"`   // gate 内的连接 id
	Entity string `json:"entity"` // 实体 id
	Seq    uint64 `json:"seq"`    // 每次占位 +1；旧节点只在 seq 更大时才执行接管通知
}

// Dir 是目录的 Redis 实现。零值不可用，用 Open。
type Dir struct {
	rdb *redis.Client
	ttl time.Duration
}

// Open 建立连接并 ping 一次：目录不可用时启动阶段就该知道（而不是等到第一次登录）。
func Open(url string, poolSize, dialTimeoutMS int, ttl time.Duration) (*Dir, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("redis url 解析失败: %w", err)
	}
	if poolSize > 0 {
		opt.PoolSize = poolSize
	}
	if dialTimeoutMS > 0 {
		opt.DialTimeout = time.Duration(dialTimeoutMS) * time.Millisecond
	}
	rdb := redis.NewClient(opt)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		return nil, fmt.Errorf("redis ping 失败: %w", err)
	}
	if ttl < 10*time.Second {
		ttl = 10 * time.Second
	}
	return &Dir{rdb: rdb, ttl: ttl}, nil
}

// Close 关掉连接池。
func (d *Dir) Close() error { return d.rdb.Close() }

// TTL 是记录的存活时间（各 gate 按 TTL/3 续期）。
func (d *Dir) TTL() time.Duration { return d.ttl }

func key(userID string) string { return "session:" + userID }

// Claim 把用户占给 e（node/gate/conn/entity），返回**占位前**的记录与新序号。
// prev == nil 表示之前没有归属。
func (d *Dir) Claim(ctx context.Context, userID string, e Entry) (prev *Entry, seq uint64, err error) {
	res, err := d.rdb.Eval(ctx, claimScript, []string{key(userID)},
		e.Node, e.Gate, e.Conn, e.Entity, int(d.ttl.Seconds())).Text()
	if err != nil {
		return nil, 0, err
	}
	var out struct {
		Prev string `json:"prev"`
		Seq  uint64 `json:"seq"`
	}
	if err := json.Unmarshal([]byte(res), &out); err != nil {
		return nil, 0, fmt.Errorf("claim 回包解不开: %w", err)
	}
	if out.Prev == "" {
		return nil, out.Seq, nil
	}
	var p Entry
	if err := json.Unmarshal([]byte(out.Prev), &p); err != nil {
		return nil, out.Seq, fmt.Errorf("旧记录解不开: %w", err)
	}
	return &p, out.Seq, nil
}

// Refresh 给仍然属于 (gate, conn) 的记录续期；不匹配（已经换人了）返回 false。
func (d *Dir) Refresh(ctx context.Context, userID, gate, conn string) (bool, error) {
	n, err := d.rdb.Eval(ctx, refreshScript, []string{key(userID)},
		gate, conn, int(d.ttl.Seconds())).Int()
	return n == 1, err
}

// Release 删除仍然属于 (gate, conn) 的记录；不匹配（已被新会话接管）不动它。
func (d *Dir) Release(ctx context.Context, userID, gate, conn string) (bool, error) {
	n, err := d.rdb.Eval(ctx, releaseScript, []string{key(userID)}, gate, conn).Int()
	return n == 1, err
}

// 返回 {"prev": <旧 JSON 或 "">, "seq": <新序号>}。
const claimScript = `
local key = KEYS[1]
local prev = redis.call('GET', key)
local seq = 1
if prev then
  local ok, decoded = pcall(cjson.decode, prev)
  if ok and decoded.seq then
    seq = tonumber(decoded.seq) + 1
  end
end
redis.call('SET', key, cjson.encode({
  node = ARGV[1], gate = ARGV[2], conn = ARGV[3], entity = ARGV[4], seq = seq,
}), 'EX', tonumber(ARGV[5]))
return cjson.encode({ prev = prev or '', seq = seq })
`

const refreshScript = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local ok, e = pcall(cjson.decode, cur)
if not ok then return 0 end
if e.gate ~= ARGV[1] or e.conn ~= ARGV[2] then return 0 end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`

const releaseScript = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local ok, e = pcall(cjson.decode, cur)
if not ok then return 0 end
if e.gate ~= ARGV[1] or e.conn ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`
