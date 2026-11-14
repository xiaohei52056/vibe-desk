package com.vibedesk.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

/**
 * 内部状态 KV：迁移标记等。不参与云同步 —— 另一台设备不该继承本机的迁移记录。
 */
@Data
@TableName("meta")
public class MetaEntry {

    @TableId(value = "k", type = IdType.INPUT)
    private String k;

    @TableField("`v`")
    private String v;
}
