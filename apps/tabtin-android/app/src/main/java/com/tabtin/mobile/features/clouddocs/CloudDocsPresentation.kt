package com.tabtin.mobile.features.clouddocs

import android.content.Context
import com.muse.mobile.R
import com.tabtin.mobile.data.model.KnowledgeTreeFlatRow
import com.tabtin.mobile.data.model.SharedResourceOwner
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.ui.theme.IdentityAvatar
import com.tabtin.mobile.util.RelativeTimeFormatter
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

internal data class CloudDocsSharerAvatar(
    val name: String,
    val seed: String,
    val imageUrl: String?,
)

internal sealed class CloudDocsRailPreview {
    data class Image(val url: String) : CloudDocsRailPreview()
    data class Text(val text: String) : CloudDocsRailPreview()
    data object Empty : CloudDocsRailPreview()
}

internal data class CloudDocsTreeSections(
    val folderRows: List<KnowledgeTreeFlatRow>,
    val documentRows: List<KnowledgeTreeFlatRow>,
) {
    val folderCount: Int get() = folderRows.count { it.depth == 0 }
    val documentCount: Int get() = documentRows.count { it.depth == 0 }
}

/** 云文档列表行上的修改时间文案和分享人头像，不进 Compose。 */
internal object CloudDocsPresentation {
    private const val META_SEPARATOR = " · "

    fun lastModified(context: Context, raw: String?): String? {
        val relative = raw?.let { RelativeTimeFormatter.format(context, it) } ?: return null
        return context.getString(R.string.cloud_docs_recently_modified_at, relative)
    }

    fun relativeTime(context: Context, raw: String?): String? {
        return raw?.let { RelativeTimeFormatter.format(context, it) }
    }

    /** 最近打开卡片预览：缩略图优先，其次正文摘要；签名 URL 不当文字露出。 */
    fun railPreview(resource: SpaceResource): CloudDocsRailPreview {
        val image = metadataString(resource, "thumbnail_url", "thumb_url", "cover_url", "cover_image", "thumbnail")
            ?.takeIf(::isHttpUrl)
            ?: resource.preview?.trim()?.takeIf(::isHttpUrl)
        if (!image.isNullOrEmpty()) return CloudDocsRailPreview.Image(image)
        if (SpaceResource.normalizedType(resource.itemType) == "tabdata") {
            val names = tableFieldNames(resource)
            if (names.isNotEmpty()) return CloudDocsRailPreview.Text(names.joinToString(" | "))
        }
        val text = resource.preview?.trim()?.takeIf { it.isNotEmpty() && !looksLikeUrl(it) }
        if (!text.isNullOrEmpty()) {
            return if (isZeroStatsFallback(text)) CloudDocsRailPreview.Empty else CloudDocsRailPreview.Text(text)
        }
        return CloudDocsRailPreview.Empty
    }

    fun typeLabel(context: Context, itemType: String, isFolder: Boolean = false): String {
        if (isFolder) return context.getString(R.string.cloud_docs_type_folder)
        return when (SpaceResource.normalizedType(itemType)) {
            "tabdata" -> context.getString(R.string.cloud_docs_type_table)
            else -> context.getString(R.string.cloud_docs_type_document)
        }
    }

    /**
     * 行次要信息：`时间 · 成员 · 类型`。
     * 缺段直接省略，不留下多余分隔符。
     */
    fun mergedMeta(time: String?, member: String?, type: String?): String? {
        val parts = listOf(time, member, type).mapNotNull { part ->
            part?.trim()?.takeIf { it.isNotEmpty() }
        }
        return parts.takeIf { it.isNotEmpty() }?.joinToString(META_SEPARATOR)
    }

    fun rowMeta(
        context: Context,
        timestamp: String?,
        member: String? = null,
        itemType: String,
        isFolder: Boolean = false,
    ): String? = mergedMeta(
        time = relativeTime(context, timestamp),
        member = member,
        type = typeLabel(context, itemType, isFolder),
    )

    fun groupTreeRows(rows: List<KnowledgeTreeFlatRow>): CloudDocsTreeSections {
        val folders = ArrayList<KnowledgeTreeFlatRow>()
        val documents = ArrayList<KnowledgeTreeFlatRow>()
        var bucketFolders = false
        for (row in rows) {
            if (row.depth == 0) {
                bucketFolders = row.isExpandable
            }
            if (bucketFolders) {
                folders.add(row)
            } else {
                documents.add(row)
            }
        }
        return CloudDocsTreeSections(folderRows = folders, documentRows = documents)
    }

    fun sharerAvatar(owner: SharedResourceOwner?): CloudDocsSharerAvatar? {
        if (owner == null) return null
        val name = owner.displayName.trim()
        val id = owner.id.trim()
        val imageUrl = owner.avatar?.trim()?.takeIf { it.isNotEmpty() }
        if (name.isEmpty() && id.isEmpty() && imageUrl == null) return null
        return CloudDocsSharerAvatar(
            name = name.ifEmpty { "?" },
            seed = IdentityAvatar.colorSeed(id, name),
            imageUrl = imageUrl,
        )
    }

    private fun metadataString(resource: SpaceResource, vararg keys: String): String? {
        val metadata = resource.metadata ?: return null
        for (key in keys) {
            val value = (metadata[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
            if (value != null) return value
        }
        return null
    }

    private fun isHttpUrl(value: String): Boolean {
        val lowered = value.lowercase()
        return lowered.startsWith("http://") || lowered.startsWith("https://")
    }

    private fun looksLikeUrl(value: String): Boolean {
        val lowered = value.lowercase()
        return isHttpUrl(value) ||
            lowered.startsWith("//") ||
            lowered.startsWith("data:") ||
            lowered.startsWith("blob:")
    }

    private val statsPreview = Regex(
        """^\d+\s+(?:行|rows?)\s*[·•]\s*\d+\s+(?:字段|fields?)$""",
        RegexOption.IGNORE_CASE,
    )

    private fun isZeroStatsFallback(text: String): Boolean {
        if (!statsPreview.matches(text)) return false
        val numbers = Regex("""\d+""").findAll(text).map { it.value.toInt() }.toList()
        return numbers.size >= 2 && numbers[0] == 0 && numbers[1] == 0
    }

    private fun tableFieldNames(resource: SpaceResource): List<String> {
        val values = resource.metadata?.get("field_names") as? JsonArray ?: return emptyList()
        return values.mapNotNull { item ->
            when (item) {
                is JsonPrimitive -> item.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
                    ?: item.intOrNull?.toString()
                else -> null
            }
        }
    }
}
