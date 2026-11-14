package com.vibedesk.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.extension.handlers.JacksonTypeHandler;
import lombok.Data;

import java.util.List;

/**
 * 决策日志：问题 / 选项 / 选了谁 / 为什么。只做笔记脚注 + 搜索命中，不做列表页。
 * opts 在库里是 JSON 文本（JacksonTypeHandler），对外是字符串数组。
 */
@Data
@TableName(value = "decisions", autoResultMap = true)
public class DecisionRecord {

    @TableId(type = IdType.INPUT)
    private String id;

    private String noteId;

    /** 问题 */
    private String q;

    /** 选项 */
    @TableField(typeHandler = JacksonTypeHandler.class)
    private List<String> opts;

    /** 选了哪个 */
    private String pick;

    /** 理由 */
    private String why;

    private Long at;
}
