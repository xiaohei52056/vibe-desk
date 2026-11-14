package com.vibedesk.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * CORS：开发时前端走 Vite 代理（同源，不需要这个）；
 * 静态构建版 / 别的端口 / 服务器页面会直连本机 8080，来源不固定，
 * 所以这里用 allowedOriginPatterns("*") 放行（纯本地工具，无凭据、无 Cookie）。
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOriginPatterns("*")
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .maxAge(3600);
    }
}
