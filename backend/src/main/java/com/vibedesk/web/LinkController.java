package com.vibedesk.web;

import com.vibedesk.entity.NoteLink;
import com.vibedesk.mapper.NoteLinkMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 双链（无向图）。key 由 a~b 归一化生成（小的 id 在前），
 * 客户端没带 key 时服务端按 a/b 现算 —— 与前端 parse/apply 的规则一致。
 */
@RestController
@RequestMapping("/api/links")
@RequiredArgsConstructor
public class LinkController {

    private final NoteLinkMapper links;

    @GetMapping
    public List<NoteLink> list() {
        return links.selectList(null);
    }

    /** upsert：key 已存在就覆盖权重 */
    @PutMapping
    public NoteLink upsert(@RequestBody NoteLink l) {
        if (l.getA() != null && l.getB() != null) {
            String x = l.getA().compareTo(l.getB()) < 0 ? l.getA() : l.getB();
            String y = l.getA().compareTo(l.getB()) < 0 ? l.getB() : l.getA();
            l.setA(x);
            l.setB(y);
            l.setLinkKey(x + "~" + y);
        }
        if (l.getW() == null) l.setW(1.0);
        if (l.getLastWalkedAt() == null) l.setLastWalkedAt(0L);
        links.insertOrUpdate(l);
        return l;
    }

    @DeleteMapping("/{key}")
    public Map<String, Object> delete(@PathVariable("key") String key) {
        return Map.of("deleted", links.deleteById(key));
    }
}
