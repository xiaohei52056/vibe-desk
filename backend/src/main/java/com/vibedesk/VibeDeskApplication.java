package com.vibedesk;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * VIBE DESK 后端。
 *
 * 前端是纯前端 + IndexedDB（见仓库根目录），这里补上服务端：
 *   · 六张业务表与前端 IndexedDB 的 store 一一对应，字段名也一致 ——
 *     同步接口 /api/sync/bundle 与前端「导出 JSON」是同一种文件，两头都能读。
 *   · 坐标契约不变：id 只在创建时分配，后端不做任何重排。
 */
@SpringBootApplication
@MapperScan("com.vibedesk.mapper")
public class VibeDeskApplication {

    public static void main(String[] args) {
        SpringApplication.run(VibeDeskApplication.class, args);
    }
}
