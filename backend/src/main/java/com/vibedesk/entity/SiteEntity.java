package com.vibedesk.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

/**
 * 站点实体配置：纪念册光门（gate）与代码星系的项目卡（project）。
 *
 * 坐标不在这里 —— 坐标是前端 coords.ts 冻结的契约，一经分配永不变。
 * 数据库只管「写什么」：名字、副标题、站外链接、项目卡三字段。
 */
@Data
@TableName("entities")
public class SiteEntity {

    @TableId(type = IdType.INPUT)
    private String id;

    private String kind;

    private String label;

    private String sub;

    private String url;

    /** JSON 文本：项目卡 {goal,current,next} 或光门 {note} */
    private String detail;

    private Long updatedAt;
}
