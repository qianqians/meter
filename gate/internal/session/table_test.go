package session

import (
	"sort"
	"testing"
)

func key(s Session) string { return s.UserID + "/" + s.EntityID + "@" + s.NodeID }

func TestBindLookupUnbind(t *testing.T) {
	tbl := New()
	if ev := tbl.Bind(Session{ConnID: "c1", UserID: "u1", EntityID: "e1", NodeID: "n1"}); ev != nil {
		t.Fatal("首次绑定不应挤掉任何人")
	}
	s, ok := tbl.ByConn("c1")
	if !ok || s.EntityID != "e1" || s.NodeID != "n1" {
		t.Fatalf("按连接查不到: %+v", s)
	}
	if s2, ok := tbl.ByEntity("e1"); !ok || s2.ConnID != "c1" {
		t.Fatalf("反向索引不对: %+v", s2)
	}
	if got := tbl.Unbind("c1"); got == nil || got.EntityID != "e1" {
		t.Fatalf("解绑返回值不对: %+v", got)
	}
	if _, ok := tbl.ByEntity("e1"); ok {
		t.Fatal("解绑后反向索引应清掉")
	}
	if got := tbl.Unbind("c1"); got != nil {
		t.Fatal("重复解绑应返回 nil")
	}
}

func TestBindEvictsOldConnForSameEntity(t *testing.T) {
	tbl := New()
	tbl.Bind(Session{ConnID: "old", UserID: "u1", EntityID: "e1", NodeID: "n1"})

	ev := tbl.Bind(Session{ConnID: "new", UserID: "u1", EntityID: "e1", NodeID: "n1"})
	if ev == nil || ev.ConnID != "old" {
		t.Fatalf("同实体重新绑定时应挤掉旧连接，实际 %+v", ev)
	}
	if _, ok := tbl.ByConn("old"); ok {
		t.Fatal("旧连接不应还在表里")
	}
	if s, _ := tbl.ByEntity("e1"); s.ConnID != "new" {
		t.Fatalf("实体应指向新连接，实际 %s", s.ConnID)
	}
}

func TestRebind(t *testing.T) {
	tbl := New()
	tbl.Bind(Session{ConnID: "c1", UserID: "u1", EntityID: "e1", NodeID: "n1"})
	if !tbl.Rebind("c1", "e2", "n2") {
		t.Fatal("改绑应成功")
	}
	if _, ok := tbl.ByEntity("e1"); ok {
		t.Fatal("旧实体映射应清掉")
	}
	if s, ok := tbl.ByEntity("e2"); !ok || s.ConnID != "c1" || s.NodeID != "n2" {
		t.Fatalf("新实体映射不对: %+v", s)
	}
}

func TestConnsOfEntitiesDedupes(t *testing.T) {
	tbl := New()
	tbl.Bind(Session{ConnID: "c1", UserID: "u1", EntityID: "e1", NodeID: "n1"})
	tbl.Bind(Session{ConnID: "c2", UserID: "u2", EntityID: "e2", NodeID: "n1"})

	// e1 与 e1-dup 都指向 c1（模拟"主人和宠物同一条连接"的场景用重复实体验证去重）
	got := tbl.ConnsOfEntities([]string{"e1", "e2", "e1", "missing"})
	sort.Strings(got)
	want := []string{"c1", "c2"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("去重/忽略未知实体结果不对: %v", got)
	}
}

func TestLenAndConnIDs(t *testing.T) {
	tbl := New()
	tbl.Bind(Session{ConnID: "c1", EntityID: "e1"})
	tbl.Bind(Session{ConnID: "c2", EntityID: "e2"})
	if tbl.Len() != 2 {
		t.Fatalf("Len=%d", tbl.Len())
	}
	if ids := tbl.ConnIDs(); len(ids) != 2 {
		t.Fatalf("ConnIDs=%v", ids)
	}
}
