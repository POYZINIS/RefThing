//! Global tag CRUD. Tags are NOT board-scoped: no `seq` bump, no event-log
//! entry, no broadcast (their `item_tags` links ride item patches instead).

use refthing_core::db::tags;
use refthing_core::error::CoreError;
use refthing_core::models;
use serde::Deserialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::dto;
use crate::services::tag_dto;

/// True when `error` is a SQLite `UNIQUE` violation (here: duplicate tag
/// name, which is unique case-insensitively).
#[must_use]
pub fn is_unique_violation(error: &sqlx::Error) -> bool {
    matches!(
        error,
        sqlx::Error::Database(db_error) if db_error.message().contains("UNIQUE constraint failed")
    )
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewTag {
    pub name: String,
    pub color: Option<String>,
}

/// Tag patch. `color` is a double option: `null` clears the color.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TagPatch {
    pub name: Option<String>,
    #[serde(deserialize_with = "crate::services::double_option")]
    pub color: Option<Option<String>>,
}

impl TagPatch {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.name.is_none() && self.color.is_none()
    }
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<dto::Tag>, CoreError> {
    let tags = tags::list(pool).await?;
    Ok(tags.into_iter().map(tag_dto).collect())
}

/// Creates a tag; duplicate names surface as [`sqlx::Error::Database`] with a
/// `UNIQUE` message (see [`is_unique_violation`]) so the route can map 409.
pub async fn create(
    pool: &SqlitePool,
    name: &str,
    color: Option<&str>,
) -> Result<dto::Tag, sqlx::Error> {
    let id = Uuid::now_v7();
    let tag = sqlx::query_as::<_, models::Tag>(
        "INSERT INTO tags (id, name, color) VALUES (?, ?, ?) RETURNING *",
    )
    .bind(id)
    .bind(name)
    .bind(color)
    .fetch_one(pool)
    .await?;
    Ok(tag_dto(tag))
}

/// Applies a tag patch. Returns `None` when no tag has `id`; duplicate renames
/// surface as `UNIQUE` violations like [`create`].
pub async fn update(
    pool: &SqlitePool,
    id: Uuid,
    patch: &TagPatch,
) -> Result<Option<dto::Tag>, sqlx::Error> {
    let existing = sqlx::query("SELECT 1 AS one FROM tags WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    if existing.is_none() {
        return Ok(None);
    }

    if let Some(name) = patch.name.as_deref() {
        sqlx::query("UPDATE tags SET name = ? WHERE id = ?")
            .bind(name)
            .bind(id)
            .execute(pool)
            .await?;
    }
    if let Some(color) = &patch.color {
        sqlx::query("UPDATE tags SET color = ? WHERE id = ?")
            .bind(color.clone())
            .bind(id)
            .execute(pool)
            .await?;
    }

    let tag = sqlx::query_as::<_, models::Tag>("SELECT * FROM tags WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(Some(tag_dto(tag)))
}

/// Deletes a tag (its `item_tags` links cascade). Returns `false` when no tag
/// has `id`.
pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<bool, CoreError> {
    tags::delete(pool, id).await
}
