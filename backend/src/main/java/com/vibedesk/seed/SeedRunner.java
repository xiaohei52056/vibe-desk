package com.vibedesk.seed;

import com.vibedesk.entity.Asset;
import com.vibedesk.mapper.AssetMapper;
import com.vibedesk.mapper.DecisionRecordMapper;
import com.vibedesk.mapper.NoteLinkMapper;
import com.vibedesk.mapper.NoteMapper;
import com.vibedesk.mapper.ReviewCardMapper;
import com.vibedesk.seed.SeedData.SeedBundle;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

import javax.imageio.ImageIO;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.Base64;

/**
 * 空库自动落种子：只认「notes 表是否为空」，已有数据永不覆盖。
 * 与前端 ensureSeeded() 同一条规矩 —— 清空自己写的数据，重启不会把它们变回来。
 */
@Component
@RequiredArgsConstructor
public class SeedRunner implements CommandLineRunner {

    private final NoteMapper notes;
    private final NoteLinkMapper links;
    private final ReviewCardMapper review;
    private final DecisionRecordMapper decisions;
    private final AssetMapper assets;
    private final SeedData seedData;

    @Override
    public void run(String... args) throws Exception {
        if (notes.selectCount(null) > 0) {
            return;
        }
        SeedBundle seed = seedData.build();
        seed.notes().forEach(notes::insert);
        seed.links().forEach(links::insert);
        seed.review().forEach(review::insert);
        seed.decisions().forEach(decisions::insert);

        // 画一颗种子星核：128×128 PNG，给 assets 表一个真实内容，
        // 「云端拉取」后 n17 的 ![星核](asset:img-seed-star) 能立刻渲染出来
        Asset star = new Asset();
        star.setId("img-seed-star");
        star.setMime("image/png");
        star.setW(128);
        star.setH(128);
        star.setAt(System.currentTimeMillis());
        star.setData(drawSeedStar());
        assets.insert(star);
    }

    /** 画星核：暗夜底 + 金色四芒星，贴项目审美 */
    private String drawSeedStar() throws Exception {
        int size = 128;
        BufferedImage img = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = img.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

        // 底：深空圆
        g.setColor(new Color(10, 16, 30));
        g.fillOval(0, 0, size, size);

        // 光晕
        g.setColor(new Color(232, 195, 126, 60));
        g.fillOval(24, 24, 80, 80);

        // 四芒星：竖横两组细长菱形
        int cx = 64, cy = 64;
        g.setColor(new Color(232, 195, 126));
        g.fillPolygon(new int[]{cx, cx + 10, cx, cx - 10}, new int[]{cy - 44, cy, cy + 44, cy}, 4);
        g.fillPolygon(new int[]{cx - 44, cx, cx + 44, cx}, new int[]{cy, cy - 10, cy, cy + 10}, 4);

        // 中点
        g.setColor(new Color(255, 236, 200));
        g.fillOval(cx - 5, cy - 5, 10, 10);

        // 外环
        g.setStroke(new BasicStroke(1.2f));
        g.setColor(new Color(232, 195, 126, 120));
        g.drawOval(14, 14, 100, 100);
        g.dispose();

        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        ImageIO.write(img, "png", baos);
        return Base64.getEncoder().encodeToString(baos.toByteArray());
    }
}
