package com.vibedesk.web;

import com.vibedesk.entity.SiteEntity;
import com.vibedesk.mapper.SiteEntityMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 站点实体配置 CRUD。前端启动时拉一次 /api/entities，之后离线用本地缓存。
 */
@RestController
@RequestMapping("/api/entities")
@RequiredArgsConstructor
public class SiteEntityController {

    private final SiteEntityMapper entities;

    @GetMapping
    public List<SiteEntity> list() {
        return entities.selectList(null);
    }

    @GetMapping("/{id}")
    public ResponseEntity<SiteEntity> get(@PathVariable String id) {
        SiteEntity e = entities.selectById(id);
        return e == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(e);
    }

    @PutMapping("/{id}")
    public SiteEntity upsert(@PathVariable String id, @RequestBody SiteEntity e) {
        e.setId(id);
        e.setUpdatedAt(System.currentTimeMillis());
        entities.insertOrUpdate(e);
        return e;
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable String id) {
        return Map.of("deleted", entities.deleteById(id));
    }
}
