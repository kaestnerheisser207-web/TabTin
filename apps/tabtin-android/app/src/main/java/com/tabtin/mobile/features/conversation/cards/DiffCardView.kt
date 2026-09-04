package com.tabtin.mobile.features.conversation.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import com.muse.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing

// 与 iOS `ToolDiffPreview` 同上限：折叠 48 行、展开 160 行。之前是 10 行，
// old/new 合成出来的 diff（两侧行数相加）几乎必被截断。
private const val COLLAPSED_LINES = 48
private const val EXPANDED_LINES = 160

@Composable
internal fun DiffCardView(step: AgentStep) {
    val path = remember(step.input) { DiffCardPresentation.path(step.input).orEmpty() }
    val diff = remember(step.input, step.output) {
        DiffCardPresentation.diff(step.input, step.output, fallback = step.output).orEmpty()
    }

    val contentLines = remember(diff) { DiffCardPresentation.contentLines(diff) }
    val addCount = remember(contentLines) { DiffCardPresentation.addedCount(contentLines) }
    val removeCount = remember(contentLines) { DiffCardPresentation.removedCount(contentLines) }
    var expanded by remember(step.id) { mutableStateOf(false) }
    val previewLines = remember(contentLines, expanded) {
        contentLines.take(if (expanded) EXPANDED_LINES else COLLAPSED_LINES)
    }
    val hasMore = contentLines.size > previewLines.size
    val title = path.substringAfterLast("/").ifEmpty { stringResource(R.string.chat_card_diff_title) }

    ToolCardContainer(
        header = {
            Text(
                title,
                style = TTFonts.captionSemibold,
                color = ChatCardTokens.textPrimary(),
                modifier = Modifier.weight(1f),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                if (addCount > 0) Text("+$addCount", style = TTFonts.caption, color = ChatCardTokens.diffAddText())
                if (removeCount > 0) Text("-$removeCount", style = TTFonts.caption, color = ChatCardTokens.diffRemoveText())
            }
        },
    ) {
        if (previewLines.isNotEmpty()) {
            SelectionContainer {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(ChatCardTokens.cardPaddingH, ChatCardTokens.cardPaddingV),
                ) {
                    previewLines.forEach { line ->
                        val (bgColor, textColor) = when {
                            line.startsWith("+") && !line.startsWith("+++") ->
                                ChatCardTokens.diffAddBg() to ChatCardTokens.diffAddText()
                            line.startsWith("-") && !line.startsWith("---") ->
                                ChatCardTokens.diffRemoveBg() to ChatCardTokens.diffRemoveText()
                            else -> Color.Transparent to ChatCardTokens.textPrimary()
                        }
                        Text(
                            line,
                            style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                            color = textColor,
                            softWrap = false,
                            modifier = Modifier.fillMaxWidth().background(bgColor),
                        )
                    }
                }
            }
            if (hasMore || expanded) {
                Text(
                    if (expanded) {
                        stringResource(R.string.chat_card_diff_collapse)
                    } else {
                        stringResource(
                            R.string.chat_card_diff_expand,
                            minOf(contentLines.size, EXPANDED_LINES),
                            contentLines.size,
                        )
                    },
                    style = TTFonts.caption,
                    color = ChatCardTokens.textAccent(),
                    modifier = Modifier
                        .clickable { expanded = !expanded }
                        .padding(horizontal = ChatCardTokens.cardPaddingH, vertical = TTSpacing.xs),
                )
            }
        }
    }
}
