# 自托管 Firecrawl

#### 贡献者？

欢迎来到 [Firecrawl](https://firecrawl.dev) 🔥！这里有一些关于如何在本地获取项目的说明，以便您可以自己运行它并做出贡献。

如果您要贡献代码，请注意流程与其他开源仓库类似，即：fork Firecrawl，进行更改，运行测试，提交 PR。

如果您有任何问题或希望获得帮助，请加入我们的 Discord 社区 [这里](https://discord.gg/gSmWdAkdwd) 获取更多信息，或在 Github [这里](https://github.com/mendableai/firecrawl/issues/new/choose) 提交问题！

## 为什么？

自托管 Firecrawl 对于有严格安全策略、要求数据保留在受控环境中的组织特别有益。以下是考虑自托管的一些关键原因：

- **增强的安全性和合规性：** 通过自托管，您可以确保所有数据处理和处理都符合内部和外部法规，将敏感信息保留在您的安全基础设施内。请注意，Firecrawl 是 Mendable 产品，依赖于 SOC2 Type2 认证，这意味着该平台遵循管理数据安全的高行业标准。
- **可定制的服务：** 自托管允许您定制服务，例如 Playwright 服务，以满足特定需求或处理标准云产品可能不支持的特定用例。
- **学习和社区贡献：** 通过设置和维护您自己的实例，您可以更深入地了解 Firecrawl 的工作原理，这也可以为项目做出更有意义的贡献。

### 注意事项

但是，需要注意一些限制和额外的责任：

1. **对 Fire-engine 的有限访问：** 目前，Firecrawl 的自托管实例无法访问 Fire-engine，其中包括处理 IP 阻止、机器人检测机制等高级功能。这意味着虽然您可以管理基本的抓取任务，但更复杂的场景可能需要额外的配置或可能不受支持。
2. **需要手动配置：** 如果您需要使用超出基本 fetch 和 Playwright 选项的抓取方法，您需要在 `.env` 文件中手动配置这些。这需要对技术有更深入的了解，可能涉及更多的设置时间。

自托管 Firecrawl 非常适合那些需要完全控制其抓取和数据处理环境的人，但需要权衡额外的维护和配置工作。

## 步骤

1. 首先，开始安装依赖项

- Docker [说明](https://docs.docker.com/get-docker/)


2. 设置环境变量

使用下面的模板在根目录中创建一个 `.env` 文件。

`.env:`
```
# ===== 必需的环境变量 ======
PORT=3002
HOST=0.0.0.0

# 要启用数据库身份验证，您需要设置 Supabase。
USE_DB_AUTHENTICATION=false

# ===== 可选的环境变量 ======

## === AI 功能（抓取时的 JSON 格式，/extract API）===
# 在此提供您的 OpenAI API 密钥以启用 AI 功能
# OPENAI_API_KEY=

# 实验性：使用 Ollama
# OLLAMA_BASE_URL=http://localhost:11434/api
# MODEL_NAME=deepseek-r1:7b
# MODEL_EMBEDDING_NAME=nomic-embed-text

# 实验性：使用任何 OpenAI 兼容的 API
# OPENAI_BASE_URL=https://example.com/v1
# OPENAI_API_KEY=

## === 代理 ===
# PROXY_SERVER 可以是完整的 URL（例如 http://0.1.2.3:1234）或只是 IP 和端口组合（例如 0.1.2.3:1234）
# 如果您的代理未经身份验证，请不要取消注释 PROXY_USERNAME 和 PROXY_PASSWORD
# PROXY_SERVER=
# PROXY_USERNAME=
# PROXY_PASSWORD=

## === /search API ===
# 默认情况下，/search API 将使用 Google 搜索。

# 如果您想使用 SearXNG 服务器而不是直接 Google，可以指定启用了 JSON 格式的 SearXNG 服务器。
# 您还可以自定义引擎和类别参数，但默认值也应该正常工作。
# SEARXNG_ENDPOINT=http://your.searxng.server
# SEARXNG_ENGINES=
# SEARXNG_CATEGORIES=

## === 其他 ===

# Supabase 设置（用于支持数据库身份验证、高级日志记录等）
# SUPABASE_ANON_TOKEN=
# SUPABASE_URL=
# SUPABASE_SERVICE_TOKEN=

# 如果您已设置身份验证并想使用真实的 API 密钥进行测试，请使用此选项
# TEST_API_KEY=

# 此密钥允许您访问队列管理面板。如果您的部署可公开访问，请更改此密钥。
BULL_AUTH_KEY=CHANGEME

# 这现在由 docker-compose.yaml 自动配置。您不需要设置它。
# PLAYWRIGHT_MICROSERVICE_URL=http://playwright-service:3000/scrape
# REDIS_URL=redis://redis:6379
# REDIS_RATE_LIMIT_URL=redis://redis:6379

# 如果您有想要用于解析 PDF 的 llamaparse 密钥，请设置
# LLAMAPARSE_API_KEY=

# 如果您想向 Slack 发送服务器健康状态消息，请设置
# SLACK_WEBHOOK_URL=

# 如果您想发送 posthog 事件（如作业日志），请设置
# POSTHOG_API_KEY=
# POSTHOG_HOST=

## === 系统资源配置 ===
# 最大 CPU 使用阈值（0.0-1.0）。当 CPU 使用率超过此值时，工作器将拒绝新作业。
# 默认值：0.8（80%）
# MAX_CPU=0.8

# 最大 RAM 使用阈值（0.0-1.0）。当内存使用率超过此值时，工作器将拒绝新作业。
# 默认值：0.8（80%）
# MAX_RAM=0.8
```

3. 构建并运行 Docker 容器：
    
    ```bash
    docker compose build
    docker compose up
    ```

这将运行一个可在 `http://localhost:3002` 访问的 Firecrawl 本地实例。

您应该能够在 `http://localhost:3002/admin/CHANGEME/queues` 上看到 Bull Queue Manager UI。

4. *（可选）* 测试 API

如果您想测试爬取端点，可以运行以下命令：

  ```bash
  curl -X POST http://localhost:3002/v1/crawl \
      -H 'Content-Type: application/json' \
      -d '{
        "url": "https://firecrawl.dev"
      }'
  ```   

## 故障排除

本节提供了在设置或运行自托管 Firecrawl 实例时可能遇到的常见问题的解决方案。

### SDK 使用的 API 密钥

**注意：** 在自托管实例中使用 Firecrawl SDK 时，API 密钥是可选的。只有在连接到云服务（api.firecrawl.dev）时才需要 API 密钥。

### Supabase 客户端未配置

**症状：**
```bash
[YYYY-MM-DDTHH:MM:SS.SSSz]ERROR - Attempted to access Supabase client when it's not configured.
[YYYY-MM-DDTHH:MM:SS.SSSz]ERROR - Error inserting scrape event: Error: Supabase client is not configured.
```

**解释：**
此错误是因为 Supabase 客户端设置未完成。您应该能够正常抓取和爬取。目前无法在自托管实例中配置 Supabase。

### 您正在绕过身份验证

**症状：**
```bash
[YYYY-MM-DDTHH:MM:SS.SSSz]WARN - You're bypassing authentication
```

**解释：**
此错误是因为 Supabase 客户端设置未完成。您应该能够正常抓取和爬取。目前无法在自托管实例中配置 Supabase。

### Docker 容器启动失败

**症状：**
Docker 容器意外退出或启动失败。

**解决方案：**
使用以下命令检查 Docker 日志中的任何错误消息：
```bash
docker logs [container_name]
```

- 确保在 .env 文件中正确设置了所有必需的环境变量。
- 验证 docker-compose.yml 中定义的所有 Docker 服务都已正确配置，并且必要的镜像可用。

### Redis 连接问题

**症状：**
与连接到 Redis 相关的错误，例如超时或"连接被拒绝"。

**解决方案：**
- 确保 Redis 服务在您的 Docker 环境中正常运行。
- 验证 .env 文件中的 REDIS_URL 和 REDIS_RATE_LIMIT_URL 指向正确的 Redis 实例，确保它指向 `docker-compose.yaml` 文件中的相同 URL（`redis://redis:6379`）
- 检查可能阻止连接到 Redis 端口的网络设置和防火墙规则。

### API 端点无响应

**症状：**
对 Firecrawl 实例的 API 请求超时或无响应。

**解决方案：**
- 通过检查 Docker 容器状态确保 Firecrawl 服务正在运行。
- 验证 .env 文件中的 PORT 和 HOST 设置是否正确，并且没有其他服务使用相同的端口。
- 检查网络配置以确保主机可从发出 API 请求的客户端访问。

通过解决这些常见问题，您可以确保自托管 Firecrawl 实例的更顺畅设置和操作。

## 在 Kubernetes 集群上安装 Firecrawl（简单版本）

阅读 [examples/kubernetes/cluster-install/README.md](https://github.com/mendableai/firecrawl/blob/main/examples/kubernetes/cluster-install/README.md) 获取在 Kubernetes 集群上安装 Firecrawl 的说明。