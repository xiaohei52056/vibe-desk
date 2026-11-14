package com.vibedesk.web;

import com.vibedesk.entity.MetaEntry;
import com.vibedesk.mapper.MetaMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 内部状态 KV。值可以是任意 JSON；存库时序列化成文本，读取时原样返回 JSON 节点。
 */
@RestController
@RequestMapping("/api/meta")
@RequiredArgsConstructor
public class MetaController {

    private final MetaMapper meta;

    @GetMapping("/{k}")
    public Map<String, Object> get(@PathVariable String k) {
        MetaEntry e = meta.selectById(k);
        return e == null
                ? Map.of("k", k, "exists", false)
                : Map.of("k", k, "exists", true, "v", e.getV());
    }

    @PutMapping("/{k}")
    public Map<String, Object> put(@PathVariable String k, @RequestBody Map<String, Object> body) {
        Object v = body.get("v");
        MetaEntry e = new MetaEntry();
        e.setK(k);
        e.setV(v == null ? null : String.valueOf(v));
        meta.insertOrUpdate(e);
        return Map.of("k", k, "saved", true);
    }

    @DeleteMapping("/{k}")
    public Map<String, Object> delete(@PathVariable String k) {
        return Map.of("deleted", meta.deleteById(k));
    }
}
