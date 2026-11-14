package com.vibedesk.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

/**
 * 双链（无向图）。前端字段叫 key（a~b），MySQL 里 key 是保留字，
 * 列名用 link_key，JSON 出入口仍叫 key —— 与前端导出文件完全一致。
 */
@Data
@TableName("links")
public class NoteLink {

    /** 无向键：小的 id 在前 */
    @TableId(value = "link_key", type = IdType.INPUT)
    @JsonProperty("key")
    private String linkKey;

    private String a;

    private String b;

    /** Hebbian 权重：走过 +1，久不走按天衰减；只映射光丝粗细 */
    private Double w;

    private Long lastWalkedAt;
}
