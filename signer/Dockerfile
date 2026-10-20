# The Dark Vault signer, built from source. TESTNET ONLY.
#
# The same image runs twice in docker-compose.yml: the main signer (the
# vaults and the escrow) and the house signer (the purse behind practice
# auctions), each with a wallet of its own.
#
# The first build takes 20-40 minutes: it compiles the Zcash proving code in
# release mode. Later builds reuse the cache and take seconds unless the code changed.

FROM rust:1-trixie AS build
WORKDIR /src
# Keep trying through a flaky connection instead of giving up after three attempts.
ENV CARGO_NET_RETRY=10
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/vault-signer /vault-signer

FROM debian:trixie-slim
# An unprivileged user, and a data folder it owns. The wallet seed, the wallet
# database and the vault list live in /data: mount a volume there and back it up.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin signer \
 && mkdir -p /data && chown signer:signer /data
COPY --from=build /vault-signer /usr/local/bin/vault-signer
USER signer
WORKDIR /data
ENV SIGNER_DATA_DIR=/data
VOLUME /data
EXPOSE 8082
ENTRYPOINT ["/usr/local/bin/vault-signer"]
