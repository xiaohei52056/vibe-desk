package com.vibedesk.web;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.vibedesk.entity.Asset;
import com.vibedesk.mapper.AssetMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 图片资源。列表默认不带 data（base64 太大，列表页只看元信息），
 * 取单张才给内容。POST 即 upsert（id 幂等）。
 */
@RestController
@RequestMapping("/api/assets")
@RequiredArgsConstructor
public class AssetController {

    private final AssetMapper assets;

    @GetMapping
    public List<Asset> listMeta() {
        QueryWrapper<Asset> qw = new QueryWrapper<>();
        qw.select("id", "mime", "w", "h", "`at`").orderByDesc("`at`");
        return assets.selectList(qw);
    }

    @GetMapping("/{id}")
    public Asset get(@PathVariable String id) {
        return assets.selectById(id);
    }

    @PostMapping
    public Asset upsert(@RequestBody Asset a) {
        if (a.getAt() == null) a.setAt(System.currentTimeMillis());
        assets.insertOrUpdate(a);
        return a;
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable String id) {
        return Map.of("deleted", assets.deleteById(id));
    }
}
