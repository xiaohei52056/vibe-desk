package com.vibedesk.web;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.vibedesk.entity.Note;
import com.vibedesk.mapper.NoteMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 笔记 CRUD。id 由客户端分配（坐标契约），POST 未带 id 时服务端兜底生成。
 */
@RestController
@RequestMapping("/api/notes")
@RequiredArgsConstructor
public class NoteController {

    private final NoteMapper notes;

    @GetMapping
    public List<Note> list() {
        QueryWrapper<Note> qw = new QueryWrapper<>();
        qw.orderByDesc("updated_at");
        return notes.selectList(qw);
    }

    @GetMapping("/{id}")
    public ResponseEntity<Note> get(@PathVariable String id) {
        Note n = notes.selectById(id);
        return n == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(n);
    }

    @PostMapping
    public Note create(@RequestBody Note n) {
        long now = System.currentTimeMillis();
        if (n.getId() == null || n.getId().isBlank()) {
            n.setId("n" + Long.toString(now, 36));
        }
        if (n.getCreatedAt() == null) n.setCreatedAt(now);
        if (n.getUpdatedAt() == null) n.setUpdatedAt(now);
        notes.insert(n);
        return n;
    }

    @PutMapping("/{id}")
    public Note update(@PathVariable String id, @RequestBody Note n) {
        n.setId(id);
        n.setUpdatedAt(System.currentTimeMillis());
        notes.insertOrUpdate(n);
        return n;
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable String id) {
        return Map.of("deleted", notes.deleteById(id));
    }
}
