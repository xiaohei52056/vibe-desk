package com.vibedesk.web;

import com.vibedesk.sync.BundleDto;
import com.vibedesk.sync.SyncService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 全量同步入口。GET 拉、POST 推 —— 与前端命令面板里的「云端拉取 / 云端推送」一一对应。
 */
@RestController
@RequestMapping("/api/sync")
@RequiredArgsConstructor
public class SyncController {

    private final SyncService sync;

    @GetMapping("/bundle")
    public BundleDto bundle() {
        return sync.read();
    }

    @PostMapping("/bundle")
    public ResponseEntity<Map<String, Object>> push(@RequestBody BundleDto bundle) {
        if (bundle == null || !"vibe-desk".equals(bundle.getApp())) {
            return ResponseEntity.badRequest().body(Map.of("ok", false, "error", "不是 VIBE DESK 的数据包"));
        }
        if (bundle.getNotes() == null || bundle.getNotes().isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("ok", false, "error", "数据包里没有笔记，拒绝清空云端"));
        }
        Map<String, Long> counts = sync.replaceAll(bundle);
        return ResponseEntity.ok(Map.of("ok", true, "counts", counts));
    }
}
