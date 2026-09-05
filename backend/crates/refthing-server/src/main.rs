#[tokio::main]
async fn main() -> anyhow::Result<()> {
    refthing_server::run().await
}
