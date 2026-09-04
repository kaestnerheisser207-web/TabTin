package com.tabtin.mobile.features.clouddocs

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.muse.mobile.R
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

@Composable
internal fun cloudDocsTypeFill(itemType: String): Color {
    return if (SpaceResource.normalizedType(itemType) == "tabdata") {
        ttColor(TTColors.CloudTableIconBackground, TTColors.Dark.CloudTableIconBackground)
    } else {
        ttColor(TTColors.CloudDocIconBackground, TTColors.Dark.CloudDocIconBackground)
    }
}

@Composable
internal fun cloudDocsTypeAccent(itemType: String): Color {
    return if (SpaceResource.normalizedType(itemType) == "tabdata") {
        ttColor(TTColors.CloudTableAccent, TTColors.Dark.CloudTableAccent)
    } else {
        ttColor(TTColors.CloudDocAccent, TTColors.Dark.CloudDocAccent)
    }
}

/** 云文档资源类型图标：无白底字形优先（对齐 iOS AppGlyph）；不用 emoji。 */
@Composable
internal fun CloudDocsAppIcon(
    itemType: String,
    modifier: Modifier = Modifier,
    size: Dp = CloudDocsRowDefaults.iconSize,
) {
    val normalizedType = SpaceResource.normalizedType(itemType)
    val background = cloudDocsTypeFill(itemType)
    Box(
        modifier = modifier
            .size(size)
            .background(background, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        TabTinAppIcon(
            appId = normalizedType,
            variant = TabTinAppIconVariant.GLYPH,
            size = size * 0.55f,
        )
    }
}

/**
 * 云文档列表统一行。三个分段共用。
 *
 * - 知识树：传 [depth] / [isExpandable] / [isExpanded]
 * - 最近 / 分享：[reservesDisclosureSpace] = false，图标贴左
 * - [meta] 是合成后的次要行（时间 · 成员 · 类型）
 */
@Composable
internal fun CloudDocsRow(
    title: String,
    itemType: String,
    meta: String?,
    modifier: Modifier = Modifier,
    depth: Int = 0,
    isPinned: Boolean = false,
    isExpandable: Boolean = false,
    isExpanded: Boolean = false,
    isLoadingChildren: Boolean = false,
    reservesDisclosureSpace: Boolean = true,
    showSeparator: Boolean = true,
    onToggleExpand: (() -> Unit)? = null,
) {
    val indent = TTSpacing.lg * depth
    val rotation by animateFloatAsState(
        targetValue = if (isExpanded) 90f else 0f,
        label = "cloudDocsChevron",
    )
    val border = ttColor(TTColors.Border, TTColors.Dark.Border)
    val separatorInset = CloudDocsRowDefaults.separatorInset(depth, reservesDisclosureSpace)

    Box(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = CloudDocsRowDefaults.minRowHeight),
    ) {
        if (depth > 0) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(start = CloudDocsRowDefaults.guideX(depth))
                    .padding(bottom = TTSpacing.sm)
                    .width(1.dp)
                    .fillMaxHeight()
                    .background(border),
            )
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = CloudDocsRowDefaults.minRowHeight)
                .padding(horizontal = CloudDocsRowDefaults.horizontalPadding)
                .padding(start = indent),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            when {
                isExpandable -> {
                    IconButton(
                        onClick = { onToggleExpand?.invoke() },
                        modifier = Modifier.size(CloudDocsRowDefaults.minHitSize),
                    ) {
                        if (isLoadingChildren) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(14.dp),
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Icon(
                                imageVector = Icons.Default.ChevronRight,
                                contentDescription = stringResource(
                                    if (isExpanded) R.string.cloud_docs_collapse else R.string.cloud_docs_expand,
                                ),
                                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                modifier = Modifier
                                    .size(16.dp)
                                    .rotate(rotation),
                            )
                        }
                    }
                }
                reservesDisclosureSpace -> {
                    Spacer(modifier = Modifier.width(CloudDocsRowDefaults.disclosureWidth))
                }
            }

            CloudDocsAppIcon(itemType = itemType)

            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(vertical = TTSpacing.xs),
                verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
            ) {
                Text(
                    text = title,
                    style = TTFonts.subtitleSemibold,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (!meta.isNullOrEmpty()) {
                    Text(
                        text = meta,
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            if (isPinned) {
                Icon(
                    imageVector = Icons.Default.PushPin,
                    contentDescription = stringResource(R.string.cloud_docs_action_pin),
                    tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                    modifier = Modifier.size(12.dp),
                )
            }
        }

        if (showSeparator) {
            HorizontalDivider(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(start = separatorInset)
                    .fillMaxWidth(),
                thickness = CloudDocsRowDefaults.separatorThickness,
                color = border,
            )
        }
    }
}

internal object CloudDocsRowDefaults {
    val iconSize = 40.dp
    val minRowHeight = 64.dp
    val minHitSize = 44.dp
    val disclosureWidth = 20.dp
    val horizontalPadding = TTSpacing.lg
    val childSeparatorInset = 92.dp
    val separatorThickness = 0.5.dp

    fun guideX(depth: Int): Dp {
        val ancestorIndent = TTSpacing.lg * (depth - 1).coerceAtLeast(0)
        return horizontalPadding + ancestorIndent + (minHitSize / 2)
    }

    fun separatorInset(depth: Int, reservesDisclosureSpace: Boolean): Dp {
        if (depth > 0) {
            return childSeparatorInset + TTSpacing.lg * (depth - 1)
        }
        val disclosure = if (reservesDisclosureSpace) disclosureWidth + TTSpacing.sm else 0.dp
        return horizontalPadding + disclosure + iconSize + TTSpacing.sm
    }
}
