package com.vibedesk.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

/**
 * 粘贴进笔记的图片资源。data 为 base64（不带 data: 前缀），
 * 与前端导出 JSON 的 assets 数组完全同构。
 */
@Data
@TableName("assets")
public class Asset {

    @TableId(type = IdType.INPUT)
    private String id;

    private String mime;

    /** 宽（像素） */
    private Integer w;

    /** 高（像素） */
    private Integer h;

    @JsonProperty("at")
    @TableField("`at`")
    private Long at;

    /** base64 图片内容 */
    private String data;
}
