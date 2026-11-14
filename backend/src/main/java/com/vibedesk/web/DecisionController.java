package com.vibedesk.web;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.vibedesk.entity.DecisionRecord;
import com.vibedesk.mapper.DecisionRecordMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 决策日志。按笔记查是主要入口（决策只做笔记脚注），全量列表给同步用。
 */
@RestController
@RequestMapping("/api/decisions")
@RequiredArgsConstructor
public class DecisionController {

    private final DecisionRecordMapper decisions;

    @GetMapping
    public List<DecisionRecord> list() {
        QueryWrapper<DecisionRecord> qw = new QueryWrapper<>();
        qw.orderByDesc("at");
        return decisions.selectList(qw);
    }

    @GetMapping("/by-note/{noteId}")
    public List<DecisionRecord> byNote(@PathVariable String noteId) {
        QueryWrapper<DecisionRecord> qw = new QueryWrapper<>();
        qw.eq("note_id", noteId).orderByDesc("at");
        return decisions.selectList(qw);
    }

    @PostMapping
    public DecisionRecord create(@RequestBody DecisionRecord d) {
        if (d.getId() == null || d.getId().isBlank()) {
            d.setId("d" + Long.toString(System.currentTimeMillis(), 36));
        }
        if (d.getAt() == null) d.setAt(System.currentTimeMillis());
        decisions.insert(d);
        return d;
    }

    @PutMapping("/{id}")
    public DecisionRecord update(@PathVariable String id, @RequestBody DecisionRecord d) {
        d.setId(id);
        decisions.insertOrUpdate(d);
        return d;
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable String id) {
        return Map.of("deleted", decisions.deleteById(id));
    }
}
