package com.tabtin.mobile.features.clouddocs

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.SubcomposeAsyncImage
import com.muse.mobile.R
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@Composable
internal fun CloudDocsRecentRail(
    items: List<SpaceResource>,
    onOpen: (SpaceResource) -> Unit,
    onSeeAll: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        RowLabel(
            title = stringResource(R.string.cloud_docs_rail_recent),
            action = stringResource(R.string.cloud_docs_browse_all),
            onAction = onSeeAll,
        )
        LazyRow(
            contentPadding = PaddingValues(horizontal = TTSpacing.lg),
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
            modifier = Modifier.padding(bottom = TTSpacing.md),
        ) {
            items(items, key = { it.id }) { resource ->
                CloudDocsRecentRailCard(
                    resource = resource,
                    onClick = { onOpen(resource) },
                )
            }
        }
    }
}

@Composable
private fun RowLabel(
    title: String,
    action: String,
    onAction: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg)
            .padding(top = TTSpacing.xs, bottom = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = title,
            style = TTFonts.captionSemibold,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        )
        Text(
            text = action,
            style = TTFonts.captionMedium,
            color = ttColor(TTColors.Accent, TTColors.Dark.Accent),
            modifier = Modifier.clickable(onClick = onAction),
        )
    }
}

@Composable
private fun CloudDocsRecentRailCard(
    resource: SpaceResource,
    onClick: () -> Unit,
) {
    val isTable = SpaceResource.normalizedType(resource.itemType) == "tabdata"
    val palette = rememberCloudDocsRailPalette(isTable)
    val shape = RoundedCornerShape(17.dp)
    Column(
        modifier = Modifier
            .width(CloudDocsRecentRailDefaults.cardWidth)
            .height(CloudDocsRecentRailDefaults.cardHeight)
            .clip(shape)
            .background(palette.wash)
            .border(1.dp, palette.accent.copy(alpha = 0.42f), shape)
            .clickable(onClick = onClick)
            .padding(9.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        CloudDocsRecentRailTypePill(
            isTable = isTable,
            accent = palette.accent,
            pillFill = palette.pill,
        )
        Text(
            text = resource.displayTitle,
            style = TTFonts.captionMedium,
            color = palette.accent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        CloudDocsRecentRailPreview(
            resource = resource,
            isTable = isTable,
            well = palette.well,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        )
    }
}

@Composable
private fun CloudDocsRecentRailTypePill(
    isTable: Boolean,
    accent: Color,
    pillFill: Color,
) {
    Row(
        modifier = Modifier
            .clip(CircleShape)
            .background(pillFill)
            .padding(horizontal = 7.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TabTinAppIcon(
            appId = if (isTable) "tabdata" else "tabdoc",
            variant = TabTinAppIconVariant.GLYPH,
            size = 14.dp,
        )
        Text(
            text = stringResource(
                if (isTable) R.string.workbench_apphome_table_type
                else R.string.workbench_apphome_doc_type,
            ),
            style = TTFonts.captionMedium,
            color = accent,
            maxLines = 1,
        )
    }
}

@Composable
private fun CloudDocsRecentRailPreview(
    resource: SpaceResource,
    isTable: Boolean,
    well: Color,
    modifier: Modifier = Modifier,
) {
    val preview = remember(resource) { CloudDocsPresentation.railPreview(resource) }
    val fallback = stringResource(
        if (isTable) R.string.workbench_apphome_table_rows_empty
        else R.string.workbench_apphome_preview_empty,
    )
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(well)
            .padding(7.dp),
        contentAlignment = Alignment.TopStart,
    ) {
        when (preview) {
            is CloudDocsRailPreview.Image -> SubcomposeAsyncImage(
                model = preview.url,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
                loading = { PreviewCaption(fallback) },
                error = { PreviewCaption(fallback) },
            )
            is CloudDocsRailPreview.Text -> PreviewCaption(preview.text)
            CloudDocsRailPreview.Empty -> PreviewCaption(fallback)
        }
    }
}

@Composable
private fun PreviewCaption(text: String) {
    Text(
        text = text,
        style = TTFonts.caption,
        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        maxLines = 3,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxSize(),
    )
}

@Composable
private fun rememberCloudDocsRailPalette(isTable: Boolean): CloudDocsRailPalette {
    val dark = isSystemInDarkTheme()
    return remember(isTable, dark) {
        val accent = when {
            isTable && dark -> Color(0xFF4ADE80)
            isTable -> Color(0xFF16A34A)
            dark -> Color(0xFF60A5FA)
            else -> Color(0xFF2563EB)
        }
        val surface = if (dark) TTColors.Dark.Card else Color.White
        CloudDocsRailPalette(
            accent = accent,
            wash = accent.copy(alpha = 0.12f),
            well = surface.copy(alpha = 0.72f),
            pill = surface.copy(alpha = 0.78f),
        )
    }
}

private data class CloudDocsRailPalette(
    val accent: Color,
    val wash: Color,
    val well: Color,
    val pill: Color,
)

private object CloudDocsRecentRailDefaults {
    val cardWidth = 148.dp
    val cardHeight = 156.dp
}
