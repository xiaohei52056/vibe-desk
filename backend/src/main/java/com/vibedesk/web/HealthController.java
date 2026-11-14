package com.vibedesk.web;

import com.vibedesk.mapper.AssetMapper;
import com.vibedesk.mapper.NoteMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** 健康检查：顺手报一下库里的数据量，前端「云端拉取」前可以用来预览。 */
@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class HealthController {

    private final NoteMapper notes;
    private final AssetMapper assets;

    @GetMapping("/health")
    public Map<String, Object> health() {
        return Map.of(
                "ok", true,
                "app", "vibe-desk-server",
                "notes", notes.selectCount(null),
                "assets", assets.selectCount(null),
                "time", System.currentTimeMillis()
        );
    }
}
