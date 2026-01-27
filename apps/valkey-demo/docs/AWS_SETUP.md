# AWS ElastiCache & MemoryDB Setup

This guide covers using Firecrawl with AWS managed Valkey-compatible services.

## Table of Contents

- [Amazon ElastiCache (Valkey)](#amazon-elasticache-valkey)
- [Amazon MemoryDB](#amazon-memorydb)
- [Connection Configuration](#connection-configuration)
- [Security Best Practices](#security-best-practices)

---

## Amazon ElastiCache (Valkey)

Amazon ElastiCache now supports Valkey as a drop-in Redis replacement.

### Create ElastiCache Cluster (Console)

1. Go to **ElastiCache** → **Valkey caches** → **Create**
2. Configure:
   - **Engine**: Valkey
   - **Engine version**: 7.2 (or latest)
   - **Node type**: `cache.t3.medium` (adjust for workload)
   - **Number of replicas**: 1-2 for HA
   - **Multi-AZ**: Enable for production

3. Network settings:
   - **VPC**: Same VPC as your Firecrawl deployment
   - **Subnet group**: Private subnets
   - **Security group**: Allow port 6379 from Firecrawl

4. Security:
   - **Encryption in-transit**: Enable (TLS)
   - **Encryption at-rest**: Enable
   - **AUTH token**: Set a strong password

### Create ElastiCache Cluster (CLI)

```bash
# Create subnet group
aws elasticache create-cache-subnet-group \
  --cache-subnet-group-name firecrawl-valkey-subnet \
  --cache-subnet-group-description "Subnet group for Firecrawl Valkey" \
  --subnet-ids subnet-xxx subnet-yyy

# Create security group
aws ec2 create-security-group \
  --group-name firecrawl-valkey-sg \
  --description "Security group for Firecrawl Valkey" \
  --vpc-id vpc-xxx

# Allow inbound from Firecrawl security group
aws ec2 authorize-security-group-ingress \
  --group-id sg-valkey \
  --protocol tcp \
  --port 6379 \
  --source-group sg-firecrawl

# Create Valkey cluster
aws elasticache create-replication-group \
  --replication-group-id firecrawl-valkey \
  --replication-group-description "Valkey for Firecrawl" \
  --engine valkey \
  --engine-version 7.2 \
  --cache-node-type cache.t3.medium \
  --num-cache-clusters 2 \
  --cache-subnet-group-name firecrawl-valkey-subnet \
  --security-group-ids sg-xxx \
  --transit-encryption-enabled \
  --at-rest-encryption-enabled \
  --auth-token "your-secure-auth-token"
```

### Get Connection Endpoint

```bash
aws elasticache describe-replication-groups \
  --replication-group-id firecrawl-valkey \
  --query 'ReplicationGroups[0].NodeGroups[0].PrimaryEndpoint'
```

---

## Amazon MemoryDB

MemoryDB provides Redis/Valkey-compatible, durable, in-memory database with Multi-AZ durability.

### Create MemoryDB Cluster (Console)

1. Go to **MemoryDB** → **Clusters** → **Create cluster**
2. Configure:
   - **Name**: `firecrawl-memorydb`
   - **Node type**: `db.t4g.medium`
   - **Number of shards**: 1 (increase for larger workloads)
   - **Replicas per shard**: 1

3. Subnet group and security:
   - Create or select subnet group in your VPC
   - Configure security group for port 6379

4. Security:
   - **TLS**: Enabled (required)
   - **ACL**: Create user with password

### Create MemoryDB Cluster (CLI)

```bash
# Create subnet group
aws memorydb create-subnet-group \
  --subnet-group-name firecrawl-memorydb-subnet \
  --subnet-ids subnet-xxx subnet-yyy

# Create ACL with user
aws memorydb create-user \
  --user-name firecrawl-user \
  --authentication-mode Type=password,Passwords="your-secure-password" \
  --access-string "on ~* +@all"

aws memorydb create-acl \
  --acl-name firecrawl-acl \
  --user-names firecrawl-user

# Create cluster
aws memorydb create-cluster \
  --cluster-name firecrawl-memorydb \
  --node-type db.t4g.medium \
  --acl-name firecrawl-acl \
  --subnet-group-name firecrawl-memorydb-subnet \
  --security-group-ids sg-xxx \
  --num-shards 1 \
  --num-replicas-per-shard 1 \
  --tls-enabled
```

### Get Connection Endpoint

```bash
aws memorydb describe-clusters \
  --cluster-name firecrawl-memorydb \
  --query 'Clusters[0].ClusterEndpoint'
```

---

## Connection Configuration

### ElastiCache Connection

```env
# .env for Firecrawl
# Note: Use 'rediss://' for TLS connections
REDIS_URL=rediss://:your-auth-token@your-cluster.xxx.cache.amazonaws.com:6379
REDIS_RATE_LIMIT_URL=rediss://:your-auth-token@your-cluster.xxx.cache.amazonaws.com:6379
```

### MemoryDB Connection

```env
# .env for Firecrawl
# MemoryDB always requires TLS
REDIS_URL=rediss://firecrawl-user:your-password@your-cluster.xxx.memorydb.amazonaws.com:6379
REDIS_RATE_LIMIT_URL=rediss://firecrawl-user:your-password@your-cluster.xxx.memorydb.amazonaws.com:6379
```

### Demo App Configuration

For the Valkey demo app, update `.env`:

```env
# ElastiCache
VALKEY_URL=rediss://:your-auth-token@your-cluster.xxx.cache.amazonaws.com:6379

# MemoryDB
VALKEY_URL=rediss://firecrawl-user:your-password@your-cluster.xxx.memorydb.amazonaws.com:6379
```

Update `valkey-client.ts` to enable TLS:

```typescript
import { GlideClient } from '@valkey/valkey-glide';

export async function getValkeyClient(): Promise<GlideClient> {
  const url = new URL(config.valkey.url.replace('rediss://', 'https://'));
  const useTLS = config.valkey.url.startsWith('rediss://');
  
  // Extract credentials from URL
  const password = url.password || undefined;
  const username = url.username || undefined;

  client = await GlideClient.createClient({
    addresses: [{ host: url.hostname, port: parseInt(url.port) || 6379 }],
    useTLS: useTLS,
    credentials: password ? { password, username } : undefined,
    requestTimeout: 5000,
    clientName: 'valkey-demo',
  });
  
  return client;
}
```

---

## Security Best Practices

### Network Security

1. **VPC Placement**: Deploy ElastiCache/MemoryDB in private subnets
2. **Security Groups**: Only allow traffic from Firecrawl instances
3. **No Public Access**: Never expose to the internet

### Authentication

1. **Strong Passwords**: Use 32+ character random passwords
2. **Rotate Credentials**: Use AWS Secrets Manager for rotation
3. **IAM Auth** (MemoryDB): Consider IAM authentication for enhanced security

### Encryption

1. **In-Transit**: Always enable TLS (`rediss://`)
2. **At-Rest**: Enable encryption at rest
3. **KMS**: Use customer-managed KMS keys for sensitive workloads

### Monitoring

```bash
# CloudWatch metrics to monitor
- CPUUtilization
- FreeableMemory
- CurrConnections
- CacheHits / CacheMisses
- ReplicationLag
```

### Cost Optimization

| Use Case | Recommended Service | Node Type |
|----------|---------------------|-----------|
| Development | ElastiCache | cache.t3.micro |
| Small Production | ElastiCache | cache.t3.medium |
| High Availability | ElastiCache Multi-AZ | cache.r6g.large |
| Durability Required | MemoryDB | db.t4g.medium |
| High Throughput | MemoryDB | db.r6g.xlarge |

---

## Terraform Example

```hcl
# elasticache.tf
resource "aws_elasticache_replication_group" "firecrawl_valkey" {
  replication_group_id       = "firecrawl-valkey"
  description                = "Valkey cluster for Firecrawl"
  engine                     = "valkey"
  engine_version             = "7.2"
  node_type                  = "cache.t3.medium"
  num_cache_clusters         = 2
  port                       = 6379
  
  subnet_group_name          = aws_elasticache_subnet_group.firecrawl.name
  security_group_ids         = [aws_security_group.valkey.id]
  
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  auth_token                 = var.valkey_auth_token
  
  automatic_failover_enabled = true
  multi_az_enabled           = true
  
  tags = {
    Name = "firecrawl-valkey"
  }
}

output "valkey_endpoint" {
  value = aws_elasticache_replication_group.firecrawl_valkey.primary_endpoint_address
}
```

---

## Troubleshooting

### Connection Timeout

- Verify security group allows port 6379
- Check VPC routing and NAT gateway
- Ensure TLS is enabled in client (`rediss://`)

### Authentication Failed

- Verify AUTH token/password is correct
- Check ACL permissions (MemoryDB)
- Ensure username is included if required

### High Latency

- Check node CPU/memory utilization
- Consider upgrading node type
- Review network path (same AZ preferred)
