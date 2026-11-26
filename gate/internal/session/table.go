// 会话表：gate 的唯一路由真相。
//
//	正向  conn_id  → (user_id, entity_id, node_id)   ｜ 上行时找逻辑节点
//	反向  entity_id → conn_id                        ｜ 逻辑层要投递给某实体时找连接
//
// 两条规则：
//
//	· 一个连接同时只绑一个"玩家实体"（宠物/召唤物这类**远程实体**不进这张表，它们是客户端的视图，
//	  不是所有权，gate 不需要为它们建反向索引）；
//	· 同一实体被新连接绑走时（同账号重登 / 断线重连），**旧连接要被挤掉并返回给调用方**，
//	  由 gate 负责踢掉它——否则会出现两条连接都以为自己拥有同一个实体。
package session

import "sync"

// Session 是一条已登录连接的路由信息。
type Session struct {
	ConnID   string
	UserID   string
	EntityID string
	NodeID   string // 该实体所在逻辑节点（gate 据此转发上行）
	ProtoVer uint32
}

// Table 并发安全的会话表。零值不可用，用 New()。
type Table struct {
	mu       sync.RWMutex
	byConn   map[string]*Session
	byEntity map[string]*Session
}

func New() *Table {
	return &Table{byConn: make(map[string]*Session), byEntity: make(map[string]*Session)}
}

// Bind 绑定一条连接。返回被挤掉的旧会话（同 entity 已绑在别的连接上时），没有则返回 nil。
func (t *Table) Bind(s Session) (evicted *Session) {
	t.mu.Lock()
	defer t.mu.Unlock()

	// 同一实体被新连接绑走：先把旧连接摘掉
	if old, ok := t.byEntity[s.EntityID]; ok && old.ConnID != s.ConnID {
		delete(t.byConn, old.ConnID)
		evicted = old
	}
	// 同一条连接重复绑定：先摘掉它自己的旧映射
	if prev, ok := t.byConn[s.ConnID]; ok && prev.EntityID != s.EntityID {
		if cur, ok2 := t.byEntity[prev.EntityID]; ok2 && cur.ConnID == s.ConnID {
			delete(t.byEntity, prev.EntityID)
		}
	}

	cp := s
	t.byConn[s.ConnID] = &cp
	t.byEntity[s.EntityID] = &cp
	return evicted
}

// Unbind 移除一条连接，返回它原来的会话（不存在则为 nil）。
func (t *Table) Unbind(connID string) *Session {
	t.mu.Lock()
	defer t.mu.Unlock()
	s, ok := t.byConn[connID]
	if !ok {
		return nil
	}
	delete(t.byConn, connID)
	if cur, ok := t.byEntity[s.EntityID]; ok && cur.ConnID == connID {
		delete(t.byEntity, s.EntityID)
	}
	return s
}

func (t *Table) ByConn(connID string) (Session, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	s, ok := t.byConn[connID]
	if !ok {
		return Session{}, false
	}
	return *s, true
}

func (t *Table) ByEntity(entityID string) (Session, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	s, ok := t.byEntity[entityID]
	if !ok {
		return Session{}, false
	}
	return *s, true
}

// Rebind 把某条连接改绑到另一个实体（换角色、实体迁移之后）。
func (t *Table) Rebind(connID, entityID, nodeID string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	s, ok := t.byConn[connID]
	if !ok {
		return false
	}
	if cur, ok := t.byEntity[s.EntityID]; ok && cur.ConnID == connID {
		delete(t.byEntity, s.EntityID)
	}
	s.EntityID = entityID
	s.NodeID = nodeID
	t.byEntity[entityID] = s
	return true
}

// Len 当前已登录连接数。
func (t *Table) Len() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.byConn)
}

// ConnIDs 所有已登录连接（广播用）。
func (t *Table) ConnIDs() []string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := make([]string, 0, len(t.byConn))
	for id := range t.byConn {
		out = append(out, id)
	}
	return out
}

// ConnsOfEntities 把实体名单翻译成连接名单，**按连接去重**（主人与宠物可能同一条连接）。
// 不在表里的实体被忽略——它们可能已下线，或还在别的 gate 上。
func (t *Table) ConnsOfEntities(entityIDs []string) []string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	seen := make(map[string]struct{}, len(entityIDs))
	out := make([]string, 0, len(entityIDs))
	for _, eid := range entityIDs {
		s, ok := t.byEntity[eid]
		if !ok {
			continue
		}
		if _, dup := seen[s.ConnID]; dup {
			continue
		}
		seen[s.ConnID] = struct{}{}
		out = append(out, s.ConnID)
	}
	return out
}
