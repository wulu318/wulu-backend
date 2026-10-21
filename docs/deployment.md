# 部署后端

仓库已提供 GitHub Actions 部署入口。首次使用时，在 GitHub 仓库 `Settings → Secrets and variables → Actions` 添加：

- `WULU_DEPLOY_HOST`：服务器 IP 或域名
- `WULU_DEPLOY_SSH_KEY`：可登录服务器的私钥，服务器对应公钥放在目标用户的 `~/.ssh/authorized_keys`
- `WULU_DEPLOY_PORT`：可选，默认 `22`
- `WULU_DEPLOY_USER`：可选，默认 `root`
- `WULU_HEALTH_URL`：可选，默认 `https://ai.005656.xyz/api/health`

配置后，可在 `Actions → Deploy WULU backend → Run workflow` 手动发布；推送到 `main` 也会自动发布。服务器端部署脚本会保留 `.env`、数据库和运行时资源，并在重启后检查 `/api/health`。
