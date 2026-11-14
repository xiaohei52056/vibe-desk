package com.vibedesk.sync;

import com.vibedesk.entity.*;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 全量数据包：与前端「导出全部数据」的 JSON 完全同构。
 * 一份文件三处通用：文件备份、前端导出导入、云端同步。
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class BundleDto {

    private String app;

    private Integer version;

    private Long at;

    private List<Note> notes;

    private List<NoteLink> links;

    private List<ReviewCard> review;

    private List<DecisionRecord> decisions;

    private List<Asset> assets;

    /** v3：光门与项目卡配置（v1/v2 旧包没有这个字段，前端当空数组处理） */
    private List<SiteEntity> entities;
}
