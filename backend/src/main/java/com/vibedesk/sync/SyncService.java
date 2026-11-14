package com.vibedesk.sync;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.vibedesk.entity.Asset;
import com.vibedesk.entity.DecisionRecord;
import com.vibedesk.entity.Note;
import com.vibedesk.entity.NoteLink;
import com.vibedesk.entity.ReviewCard;
import com.vibedesk.mapper.AssetMapper;
import com.vibedesk.mapper.DecisionRecordMapper;
import com.vibedesk.mapper.NoteLinkMapper;
import com.vibedesk.mapper.NoteMapper;
import com.vibedesk.mapper.ReviewCardMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;

/**
 * 全量同步：读整库成一份 Bundle / 把一份 Bundle 替换进库。
 *
 * 替换不是合并：合并需要解决「同 id 不同内容谁赢」，替换语义可预期，
 * 且与前端「导入是替换」的原则一致。替换前请先拉一次当备份。
 */
@Service
@RequiredArgsConstructor
public class SyncService {

    private final NoteMapper notes;
    private final NoteLinkMapper links;
    private final ReviewCardMapper review;
    private final DecisionRecordMapper decisions;
    private final AssetMapper assets;

    /** 读整库：五张表 → 一份 Bundle */
    public BundleDto read() {
        return new BundleDto(
                "vibe-desk", 2, System.currentTimeMillis(),
                notes.selectList(new QueryWrapper<Note>().orderByAsc("id")),
                links.selectList(new QueryWrapper<NoteLink>().orderByAsc("link_key")),
                review.selectList(new QueryWrapper<ReviewCard>().orderByAsc("note_id")),
                decisions.selectList(new QueryWrapper<DecisionRecord>().orderByAsc("id")),
                assets.selectList(new QueryWrapper<Asset>().orderByAsc("id"))
        );
    }

    /** 替换式写入：清空五张表再逐条插入，整个方法在一个事务里 */
    @Transactional
    public Map<String, Long> replaceAll(BundleDto bundle) {
        notes.delete(null);
        links.delete(null);
        review.delete(null);
        decisions.delete(null);
        assets.delete(null);

        for (Note n : nz(bundle.getNotes())) notes.insert(n);
        for (NoteLink l : nz(bundle.getLinks())) links.insert(l);
        for (ReviewCard r : nz(bundle.getReview())) review.insert(r);
        for (DecisionRecord d : nz(bundle.getDecisions())) decisions.insert(d);
        for (Asset a : nz(bundle.getAssets())) assets.insert(a);

        return Map.of(
                "notes", (long) nz(bundle.getNotes()).size(),
                "links", (long) nz(bundle.getLinks()).size(),
                "review", (long) nz(bundle.getReview()).size(),
                "decisions", (long) nz(bundle.getDecisions()).size(),
                "assets", (long) nz(bundle.getAssets()).size()
        );
    }

    private <T> java.util.List<T> nz(java.util.List<T> it) {
        return it == null ? java.util.List.of() : it;
    }
}
