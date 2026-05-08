#!/bin/bash

# 查找 apps 目录下所有名为 Dockerfile 的文件
find apps -name "Dockerfile" | while read -r df; do
    echo "正在处理: $df"
    
    # 逻辑说明：
    # 1. 匹配包含 'go mod download' 的行
    # 2. 在该行之前插入环境变量设置
    # 3. 使用 -i 直接修改文件内容
    
    # 针对 Go 代理的通用插入
    sed -i '/go mod download/i \    export GOPROXY=https://goproxy.cn,direct && \\' "$df"
    
    # 顺便处理可能存在的 pnpm/npm 慢的问题（可选）
    sed -i '/pnpm install/i \    RUN pnpm config set registry https://registry.npmmirror.com && \\' "$df"
done

echo "所有 Dockerfile 代理配置已更新！"
