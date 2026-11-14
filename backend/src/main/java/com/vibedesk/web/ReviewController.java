package com.vibedesk.web;

import com.vibedesk.entity.ReviewCard;
import com.vibedesk.mapper.ReviewCardMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 回看队列：一篇笔记一张卡，PUT 即 upsert。
 */
@RestController
@RequestMapping("/api/review")
@RequiredArgsConstructor
public class ReviewController {

    private final ReviewCardMapper review;

    @GetMapping
    public List<ReviewCard> list() {
        return review.selectList(null);
    }

    @PutMapping
    public ReviewCard upsert(@RequestBody ReviewCard r) {
        review.insertOrUpdate(r);
        return r;
    }

    @DeleteMapping("/{noteId}")
    public Map<String, Object> delete(@PathVariable String noteId) {
        return Map.of("deleted", review.deleteById(noteId));
    }
}
