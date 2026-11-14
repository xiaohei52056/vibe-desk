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
}
