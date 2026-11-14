package com.vibedesk.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

/**
 * 笔记。与前端 IndexedDB 的 notes store 同构：
 * id/title/body/createdAt/updatedAt，时间一律 epoch 毫秒。
 */
@Data
@TableName("notes")
public class Note {

    /** 坐标契约：id 一经分配永不变 */
    @TableId(type = IdType.INPUT)
    private String id;

    private String title;

    /** Markdown 正文，含 [[双链]]、#标签、代码块 */
    private String body;

    private Long createdAt;

    private Long updatedAt;
}
