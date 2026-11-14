package com.vibedesk.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

/**
 * 回看卡片（间隔重复）。一篇笔记一张：noteId 即主键。
 * 答题结果推进间隔：1→3→7→×2，上限 45 天。
 */
@Data
@TableName("review")
public class ReviewCard {

    @TableId(value = "note_id", type = IdType.INPUT)
    private String noteId;

    private Long dueAt;

    private Long lastAt;

    private Integer iv;
}
