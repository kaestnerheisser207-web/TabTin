package com.tabtin.mobile.features.clouddocs

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.automirrored.filled.Article
import androidx.compose.material.icons.filled.TableChart
import androidx.hilt.navigation.compose.hiltViewModel
import com.muse.mobile.R
import com.tabtin.mobile.data.model.KnowledgeTreeFlatRow
import com.tabtin.mobile.data.model.KnowledgeTreeNode
import com.tabtin.mobile.data.model.KnowledgeTreeSearchHit
import com.tabtin.mobile.data.model.SharedResourceItem
import com.tabtin.mobile.data.model.SharedResourceType
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 云文档一级入口：三分段（全部 / 最近 / 分享给我）+ 搜索 + 行操作。
 * 打开资源走 [onNavigateToResource] → MainScreen 的 resolveCloudResourceDestination。
 *
 * [pendingOpen]：深链 / 通知切到本 Tab 后待打开的资源（对齐 iOS openPendingResource）。
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
internal fun CloudDocsTabScreen(
    organizationId: String,
    onNavigateToResource: (resource: SpaceResource, spaceName: String?) -> Unit,
    onNavigateFromEvent: (resource: SpaceResource, spaceName: String?) -> Unit =
        onNavigateToResource,
    pendingOpen: CloudDocsPendingOpen? = null,
    onPendingOpenConsumed: () -> Unit = {},
    viewModel: CloudDocsViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current

    var pendingDeletion by remember { mutableStateOf<CloudDocsDeletionTarget?>(null) }
    var shareTarget by remember { mutableStateOf<CloudDocsShareTarget?>(null) }

    LaunchedEffect(organizationId) {
        if (organizationId.isNotBlank()) {
            viewModel.load(organizationId)
        }
    }

    LaunchedEffect(pendingOpen) {
        val target = pendingOpen ?: return@LaunchedEffect
        viewModel.submitPendingOpen(target)
        onPendingOpenConsumed()
    }

    LaunchedEffect(viewModel) {
        viewModel.openEvents.collect { event ->
            when (event) {
                is CloudDocsOpenEvent.Navigate ->
                    onNavigateFromEvent(event.resource, event.spaceName)
                is CloudDocsOpenEvent.Notice -> {
                    val message = when (val notice = event.notice) {
                        CloudDocsOpenNotice.OrganizationUnavailable ->
                            context.getString(R.string.resource_deep_link_organization_unavailable)
                        is CloudDocsOpenNotice.Unsupported -> {
                            val hint = notice.locationHint?.takeIf { it.isNotBlank() }
                            if (hint == null) {
                                context.getString(R.string.resource_deep_link_unsupported_type)
                            } else {
                                context.getString(
                                    R.string.resource_deep_link_unsupported_type_with_hint,
                                    hint,
                                )
                            }
                        }
                        is CloudDocsOpenNotice.Failed -> context.getString(notice.messageRes)
                    }
                    android.widget.Toast.makeText(
                        context,
                        message,
                        android.widget.Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        TabSearchField(
            query = state.searchText,
            onQueryChange = viewModel::updateSearchText,
            placeholder = stringResource(R.string.cloud_docs_search_placeholder),
            modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
        )

        CloudDocsSegmentedControl(
            selected = state.browseView,
            onSelected = viewModel::selectBrowseView,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.md),
        )

        when {
            organizationId.isBlank() -> {
                val copy = emptyCopy(state)
                CloudDocsEmptyBlock(
                    title = copy.title,
                    subtitle = copy.subtitle,
                )
            }
            state.isLoading -> {
                CloudDocsLoadingBlock()
            }
            segmentErrorRes(state) != null -> {
                CloudDocsErrorBlock(
                    message = stringResource(segmentErrorRes(state) ?: R.string.error_unknown),
                    onRetry = { viewModel.load(organizationId) },
                )
            }
            else -> {
                PullToRefreshBox(
                    isRefreshing = state.isRefreshing,
                    onRefresh = { viewModel.load(organizationId, isPullToRefresh = true) },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    when (state.browseView) {
                        CloudDocsBrowseView.ALL -> {
                            if (state.isSearching) {
                                CloudDocsRowList(
                                    items = state.searchHits,
                                    empty = emptyCopy(state),
                                    onEmptyAction = { viewModel.updateSearchText("") },
                                    key = { it.id },
                                ) { hit ->
                                    SearchHitRow(
                                        hit = hit,
                                        meta = CloudDocsPresentation.mergedMeta(
                                            CloudDocsPresentation.relativeTime(context, hit.node.updatedAt),
                                            hit.path.takeIf { it.isNotEmpty() }?.joinToString(" / "),
                                            CloudDocsPresentation.typeLabel(
                                                context,
                                                hit.node.nodeType.wireValue,
                                                isFolder = hit.node.childCount > 0,
                                            ),
                                        ),
                                        isPinned = hit.node.isPinned,
                                        pinning = hit.node.contextItemId in state.pinningIds,
                                        onOpen = {
                                            openNode(organizationId, hit.node, viewModel, onNavigateToResource)
                                        },
                                        onTogglePin = {
                                            manageableContextItemId(hit.node.contextItemId)?.let { id ->
                                                viewModel.togglePin(id, hit.node.isPinned)
                                            }
                                        },
                                        onDelete = {
                                            manageableContextItemId(hit.node.contextItemId)?.let { id ->
                                                pendingDeletion = CloudDocsDeletionTarget(id, hit.node.displayTitle)
                                            }
                                        },
                                        onShare = {
                                            shareTarget = resolveShareTarget(
                                                itemType = hit.node.nodeType.wireValue,
                                                resourceId = hit.node.resourceId,
                                                title = hit.node.displayTitle,
                                                canShare = null,
                                            )
                                        },
                                    )
                                }
                            } else {
                                CloudDocsAllBrowseList(
                                    state = state,
                                    organizationId = organizationId,
                                    viewModel = viewModel,
                                    onNavigateToResource = onNavigateToResource,
                                    onDelete = { pendingDeletion = it },
                                    onShare = { shareTarget = it },
                                )
                            }
                        }
                        CloudDocsBrowseView.RECENT -> {
                            CloudDocsRowList(
                                items = state.filteredRecentItems,
                                empty = emptyCopy(state),
                                onEmptyAction = {
                                    if (state.isSearching) {
                                        viewModel.updateSearchText("")
                                    } else {
                                        viewModel.selectBrowseView(CloudDocsBrowseView.ALL)
                                    }
                                },
                                key = { it.id },
                            ) { resource ->
                                RecentRow(
                                    resource = resource,
                                    meta = CloudDocsPresentation.rowMeta(
                                        context = context,
                                        timestamp = resource.lastVisitedAt,
                                        member = resource.owner?.presentableName,
                                        itemType = resource.itemType,
                                    ),
                                    pinning = resource.id in state.pinningIds,
                                    onOpen = {
                                        viewModel.recordAccess(resource.id)
                                        onNavigateToResource(resource, resource.spaceName)
                                    },
                                    onTogglePin = {
                                        viewModel.togglePin(resource.id, resource.isPinned == true)
                                    },
                                    onDelete = {
                                        pendingDeletion = CloudDocsDeletionTarget(
                                            resource.id,
                                            resource.displayTitle,
                                        )
                                    },
                                    onShare = {
                                        shareTarget = resolveShareTarget(
                                            itemType = resource.itemType,
                                            resourceId = resource.resourceId,
                                            title = resource.displayTitle,
                                            canShare = resource.canShare,
                                        )
                                    },
                                )
                            }
                        }
                        CloudDocsBrowseView.SHARED -> {
                            CloudDocsRowList(
                                items = state.filteredSharedItems,
                                empty = emptyCopy(state),
                                onEmptyAction = {
                                    if (state.isSearching) {
                                        viewModel.updateSearchText("")
                                    } else {
                                        viewModel.selectBrowseView(CloudDocsBrowseView.ALL)
                                    }
                                },
                                key = { it.id },
                            ) { item ->
                                SharedRow(
                                    item = item,
                                    meta = CloudDocsPresentation.rowMeta(
                                        context = context,
                                        timestamp = item.updatedAt,
                                        member = item.sharedBy?.displayName,
                                        itemType = item.resourceType.wireValue,
                                    ),
                                    onOpen = {
                                        onNavigateToResource(item.toSpaceResource(), null)
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    pendingDeletion?.let { target ->
        AlertDialog(
            onDismissRequest = { pendingDeletion = null },
            title = { Text(target.title) },
            text = {
                Text(stringResource(R.string.cloud_docs_delete_confirm_message, target.title))
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingDeletion = null
                        viewModel.delete(target.id)
                    },
                ) {
                    Text(stringResource(R.string.cloud_docs_action_delete))
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingDeletion = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }

    shareTarget?.let { target ->
        CloudDocsShareSheet(
            target = target,
            onDismiss = { shareTarget = null },
        )
    }
}

/** 云文档顶栏的新建入口，放在全局通知按钮左侧以对齐 iOS。 */
@Composable
internal fun CloudDocsCreateTopBarAction(
    organizationId: String,
    viewModel: CloudDocsViewModel,
    tint: Color,
) {
    val state by viewModel.uiState.collectAsState()
    var showCreateMenu by remember { mutableStateOf(false) }

    Box {
        IconButton(
            onClick = { showCreateMenu = true },
            enabled = organizationId.isNotBlank() && !state.isCreating,
        ) {
            if (state.isCreating) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    color = tint,
                    strokeWidth = 2.dp,
                )
            } else {
                Icon(
                    Icons.Default.Add,
                    contentDescription = stringResource(R.string.cloud_docs_new),
                    tint = tint,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        DropdownMenu(
            expanded = showCreateMenu,
            onDismissRequest = { showCreateMenu = false },
        ) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.cloud_docs_new_document)) },
                leadingIcon = { Icon(Icons.AutoMirrored.Filled.Article, contentDescription = null) },
                onClick = {
                    showCreateMenu = false
                    viewModel.create(CloudDocsCreateKind.DOCUMENT)
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.cloud_docs_new_table)) },
                leadingIcon = { Icon(Icons.Default.TableChart, contentDescription = null) },
                onClick = {
                    showCreateMenu = false
                    viewModel.create(CloudDocsCreateKind.TABLE)
                },
            )
        }
    }
}

@Composable
private fun CloudDocsSegmentedControl(
    selected: CloudDocsBrowseView,
    onSelected: (CloudDocsBrowseView) -> Unit,
    modifier: Modifier = Modifier,
) {
    val views = CloudDocsBrowseView.entries
    SingleChoiceSegmentedButtonRow(modifier = modifier) {
        views.forEachIndexed { index, view ->
            SegmentedButton(
                selected = selected == view,
                onClick = { onSelected(view) },
                shape = SegmentedButtonDefaults.itemShape(index, views.size),
            ) {
                Text(text = view.localizedLabel())
            }
        }
    }
}

@Composable
private fun CloudDocsBrowseView.localizedLabel(): String = when (this) {
    CloudDocsBrowseView.ALL -> stringResource(R.string.cloud_docs_browse_all)
    CloudDocsBrowseView.RECENT -> stringResource(R.string.cloud_docs_browse_recent)
    CloudDocsBrowseView.SHARED -> stringResource(R.string.cloud_docs_browse_shared)
}

@Composable
private fun CloudDocsAllBrowseList(
    state: CloudDocsUiState,
    organizationId: String,
    viewModel: CloudDocsViewModel,
    onNavigateToResource: (SpaceResource, String?) -> Unit,
    onDelete: (CloudDocsDeletionTarget) -> Unit,
    onShare: (CloudDocsShareTarget?) -> Unit,
) {
    val sections = remember(state.treeRows) { CloudDocsPresentation.groupTreeRows(state.treeRows) }
    val showRail = state.recentItems.isNotEmpty()
    val empty = emptyCopy(state)
    if (state.treeRows.isEmpty() && !showRail) {
        CloudDocsEmptyBlock(
            title = empty.title,
            subtitle = empty.subtitle,
            actionLabel = empty.actionLabel,
            onAction = { viewModel.create(CloudDocsCreateKind.DOCUMENT) },
            actionEnabled = !state.isCreating,
        )
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(vertical = TTSpacing.xs),
    ) {
        if (showRail) {
            item(key = "cloud-docs-recent-rail") {
                CloudDocsRecentRail(
                    items = state.recentItems.take(8),
                    onOpen = { resource ->
                        viewModel.recordAccess(resource.id)
                        onNavigateToResource(resource, resource.spaceName)
                    },
                    onSeeAll = { viewModel.selectBrowseView(CloudDocsBrowseView.RECENT) },
                )
            }
        }
        if (state.treeRows.isEmpty()) {
            item(key = "cloud-docs-all-empty") {
                CloudDocsEmptyBlock(
                    title = empty.title,
                    subtitle = empty.subtitle,
                    actionLabel = empty.actionLabel,
                    onAction = { viewModel.create(CloudDocsCreateKind.DOCUMENT) },
                    actionEnabled = !state.isCreating,
                    fill = false,
                )
            }
        } else {
            if (sections.folderRows.isNotEmpty()) {
                item(key = "cloud-docs-section-folders") {
                    CloudDocsSectionHeader(
                        title = stringResource(R.string.cloud_docs_section_folders),
                        count = sections.folderCount,
                    )
                }
                itemsIndexed(sections.folderRows, key = { _, row -> row.id }) { index, row ->
                    AllBrowseTreeRow(
                        row = row,
                        state = state,
                        showSeparator = index < sections.folderRows.lastIndex,
                        organizationId = organizationId,
                        viewModel = viewModel,
                        onNavigateToResource = onNavigateToResource,
                        onDelete = onDelete,
                        onShare = onShare,
                    )
                }
            }
            if (sections.documentRows.isNotEmpty()) {
                item(key = "cloud-docs-section-docs") {
                    CloudDocsSectionHeader(
                        title = stringResource(R.string.cloud_docs_section_docs_and_tables),
                        count = sections.documentCount,
                    )
                }
                itemsIndexed(sections.documentRows, key = { _, row -> row.id }) { index, row ->
                    AllBrowseTreeRow(
                        row = row,
                        state = state,
                        showSeparator = index < sections.documentRows.lastIndex,
                        organizationId = organizationId,
                        viewModel = viewModel,
                        onNavigateToResource = onNavigateToResource,
                        onDelete = onDelete,
                        onShare = onShare,
                    )
                }
            }
        }
    }
}

@Composable
private fun AllBrowseTreeRow(
    row: KnowledgeTreeFlatRow,
    state: CloudDocsUiState,
    showSeparator: Boolean,
    organizationId: String,
    viewModel: CloudDocsViewModel,
    onNavigateToResource: (SpaceResource, String?) -> Unit,
    onDelete: (CloudDocsDeletionTarget) -> Unit,
    onShare: (CloudDocsShareTarget?) -> Unit,
) {
    val context = LocalContext.current
    TreeRow(
        row = row,
        isExpanded = row.node.id in state.expandedNodeIds,
        isLoadingChildren = row.node.id in state.loadingChildNodeIds,
        meta = CloudDocsPresentation.rowMeta(
            context = context,
            timestamp = row.node.updatedAt,
            itemType = row.node.nodeType.wireValue,
            isFolder = row.isExpandable,
        ),
        pinning = row.node.contextItemId in state.pinningIds,
        showSeparator = showSeparator,
        onOpen = {
            openNode(organizationId, row.node, viewModel, onNavigateToResource)
        },
        onToggleExpand = { viewModel.toggleExpansion(row.node) },
        onTogglePin = {
            manageableContextItemId(row.node.contextItemId)?.let { id ->
                viewModel.togglePin(id, row.node.isPinned)
            }
        },
        onDelete = {
            manageableContextItemId(row.node.contextItemId)?.let { id ->
                onDelete(CloudDocsDeletionTarget(id, row.node.displayTitle))
            }
        },
        onShare = {
            onShare(
                resolveShareTarget(
                    itemType = row.node.nodeType.wireValue,
                    resourceId = row.node.resourceId,
                    title = row.node.displayTitle,
                    canShare = null,
                ),
            )
        },
    )
}

@Composable
private fun CloudDocsSectionHeader(title: String, count: Int) {
    Text(
        text = "$title $count",
        style = TTFonts.captionSemibold,
        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg)
            .padding(top = TTSpacing.md, bottom = TTSpacing.xs),
    )
}

@Composable
private fun <T> CloudDocsRowList(
    items: List<T>,
    empty: CloudDocsEmptyCopy,
    onEmptyAction: () -> Unit,
    key: (T) -> Any,
    row: @Composable (T) -> Unit,
) {
    if (items.isEmpty()) {
        CloudDocsEmptyBlock(
            title = empty.title,
            subtitle = empty.subtitle,
            actionLabel = empty.actionLabel,
            onAction = onEmptyAction,
        )
        return
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(vertical = TTSpacing.xs),
    ) {
        items(items, key = key) { item ->
            row(item)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TreeRow(
    row: KnowledgeTreeFlatRow,
    isExpanded: Boolean,
    isLoadingChildren: Boolean,
    meta: String?,
    pinning: Boolean,
    showSeparator: Boolean,
    onOpen: () -> Unit,
    onToggleExpand: () -> Unit,
    onTogglePin: () -> Unit,
    onDelete: () -> Unit,
    onShare: () -> Unit,
) {
    val manageId = manageableContextItemId(row.node.contextItemId)
    val shareAvailable = resolveShareTarget(
        itemType = row.node.nodeType.wireValue,
        resourceId = row.node.resourceId,
        title = row.node.displayTitle,
        canShare = null,
    ) != null
    ManagedRowShell(
        canManage = manageId != null,
        isPinned = row.node.isPinned,
        pinning = pinning,
        canShare = shareAvailable,
        onOpen = onOpen,
        onTogglePin = onTogglePin,
        onDelete = onDelete,
        onShare = onShare,
    ) {
        CloudDocsRow(
            title = row.node.displayTitle,
            itemType = row.node.nodeType.wireValue,
            meta = meta,
            depth = row.depth,
            isPinned = row.node.isPinned,
            isExpandable = row.isExpandable,
            isExpanded = isExpanded,
            isLoadingChildren = isLoadingChildren,
            reservesDisclosureSpace = row.isExpandable,
            showSeparator = showSeparator,
            onToggleExpand = onToggleExpand,
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SearchHitRow(
    hit: KnowledgeTreeSearchHit,
    meta: String?,
    isPinned: Boolean,
    pinning: Boolean,
    onOpen: () -> Unit,
    onTogglePin: () -> Unit,
    onDelete: () -> Unit,
    onShare: () -> Unit,
) {
    val manageId = manageableContextItemId(hit.node.contextItemId)
    val shareAvailable = resolveShareTarget(
        itemType = hit.node.nodeType.wireValue,
        resourceId = hit.node.resourceId,
        title = hit.node.displayTitle,
        canShare = null,
    ) != null
    ManagedRowShell(
        canManage = manageId != null,
        isPinned = isPinned,
        pinning = pinning,
        canShare = shareAvailable,
        onOpen = onOpen,
        onTogglePin = onTogglePin,
        onDelete = onDelete,
        onShare = onShare,
    ) {
        CloudDocsRow(
            title = hit.node.displayTitle,
            itemType = hit.node.nodeType.wireValue,
            meta = meta,
            isPinned = isPinned,
            reservesDisclosureSpace = false,
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RecentRow(
    resource: SpaceResource,
    meta: String?,
    pinning: Boolean,
    onOpen: () -> Unit,
    onTogglePin: () -> Unit,
    onDelete: () -> Unit,
    onShare: () -> Unit,
) {
    val shareAvailable = resolveShareTarget(
        itemType = resource.itemType,
        resourceId = resource.resourceId,
        title = resource.displayTitle,
        canShare = resource.canShare,
    ) != null
    ManagedRowShell(
        canManage = true,
        isPinned = resource.isPinned == true,
        pinning = pinning,
        canShare = shareAvailable,
        onOpen = onOpen,
        onTogglePin = onTogglePin,
        onDelete = onDelete,
        onShare = onShare,
    ) {
        CloudDocsRow(
            title = resource.displayTitle,
            itemType = resource.itemType,
            meta = meta,
            isPinned = resource.isPinned == true,
            reservesDisclosureSpace = false,
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SharedRow(
    item: SharedResourceItem,
    meta: String?,
    onOpen: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Box {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(
                    onClick = onOpen,
                    onLongClick = { menuOpen = true },
                ),
        ) {
            CloudDocsRow(
                title = item.displayTitle,
                itemType = when (item.resourceType) {
                    SharedResourceType.DOC -> "tabdoc"
                    SharedResourceType.TABLE -> "tabdata"
                },
                meta = meta,
                reservesDisclosureSpace = false,
            )
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.cloud_open)) },
                onClick = {
                    menuOpen = false
                    onOpen()
                },
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ManagedRowShell(
    canManage: Boolean,
    isPinned: Boolean,
    pinning: Boolean,
    canShare: Boolean,
    onOpen: () -> Unit,
    onTogglePin: () -> Unit,
    onDelete: () -> Unit,
    onShare: () -> Unit,
    content: @Composable () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Box {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(
                    onClick = onOpen,
                    onLongClick = {
                        if (canManage || canShare) menuOpen = true
                    },
                ),
        ) {
            content()
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            if (canShare) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.cloud_docs_share_action)) },
                    onClick = {
                        menuOpen = false
                        onShare()
                    },
                )
            }
            if (canManage) {
                DropdownMenuItem(
                    text = {
                        Text(
                            stringResource(
                                if (isPinned) {
                                    R.string.cloud_docs_action_unpin
                                } else {
                                    R.string.cloud_docs_action_pin
                                },
                            ),
                        )
                    },
                    onClick = {
                        menuOpen = false
                        onTogglePin()
                    },
                    enabled = !pinning,
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.cloud_docs_action_delete)) },
                    onClick = {
                        menuOpen = false
                        onDelete()
                    },
                )
            }
        }
    }
}

@Composable
private fun CloudDocsLoadingBlock() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
            Text(
                text = stringResource(R.string.common_loading),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }
    }
}

@Composable
private fun CloudDocsErrorBlock(message: String, onRetry: () -> Unit) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = TTSpacing.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Text(
                text = message,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                textAlign = TextAlign.Center,
            )
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.common_retry))
            }
        }
    }
}

private data class CloudDocsEmptyCopy(
    val title: String,
    val subtitle: String,
    val actionLabel: String,
)

@Composable
private fun CloudDocsEmptyBlock(
    title: String,
    subtitle: String,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    actionEnabled: Boolean = true,
    fill: Boolean = true,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .then(if (fill) Modifier.fillMaxSize() else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = TTSpacing.xl, vertical = TTSpacing.xxl),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            CloudDocsAppIcon(
                itemType = "tabdoc",
                size = TTFonts.DecorativeIcon.EMPTY_LG.size.dp,
            )
            Text(
                text = title,
                style = TTFonts.subtitleSemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                textAlign = TextAlign.Center,
            )
            Text(
                text = subtitle,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                textAlign = TextAlign.Center,
            )
            if (!actionLabel.isNullOrEmpty() && onAction != null) {
                Button(
                    onClick = onAction,
                    enabled = actionEnabled,
                    modifier = Modifier.padding(top = TTSpacing.xs),
                ) {
                    Text(text = actionLabel, style = TTFonts.bodyMedium)
                }
            }
        }
    }
}

private fun segmentErrorRes(state: CloudDocsUiState): Int? = when (state.browseView) {
    CloudDocsBrowseView.ALL, CloudDocsBrowseView.RECENT -> state.errorRes
    CloudDocsBrowseView.SHARED -> state.sharedErrorRes
}

@Composable
private fun emptyCopy(state: CloudDocsUiState): CloudDocsEmptyCopy {
    if (state.isSearching) {
        return CloudDocsEmptyCopy(
            title = stringResource(R.string.cloud_docs_empty_search),
            subtitle = stringResource(R.string.cloud_docs_empty_search_hint),
            actionLabel = stringResource(R.string.cloud_docs_clear_search),
        )
    }
    return when (state.browseView) {
        CloudDocsBrowseView.ALL -> CloudDocsEmptyCopy(
            title = stringResource(R.string.cloud_docs_empty_all),
            subtitle = stringResource(R.string.cloud_docs_empty_all_hint),
            actionLabel = stringResource(R.string.cloud_docs_new_document),
        )
        CloudDocsBrowseView.RECENT -> CloudDocsEmptyCopy(
            title = stringResource(R.string.cloud_docs_empty_recent),
            subtitle = stringResource(R.string.cloud_docs_empty_recent_hint),
            actionLabel = stringResource(R.string.cloud_docs_empty_action_browse_all),
        )
        CloudDocsBrowseView.SHARED -> CloudDocsEmptyCopy(
            title = stringResource(R.string.cloud_docs_empty_shared),
            subtitle = stringResource(R.string.cloud_docs_empty_shared_hint),
            actionLabel = stringResource(R.string.cloud_docs_empty_action_browse_all),
        )
    }
}

private fun openNode(
    organizationId: String,
    node: KnowledgeTreeNode,
    viewModel: CloudDocsViewModel,
    onNavigateToResource: (SpaceResource, String?) -> Unit,
) {
    val resource = node.toSpaceResource(organizationId) ?: return
    viewModel.recordAccess(node.contextItemId)
    onNavigateToResource(resource, null)
}

private fun KnowledgeTreeNode.toSpaceResource(organizationId: String): SpaceResource? {
    val rid = resourceId?.takeIf { it.isNotBlank() } ?: return null
    return SpaceResource(
        id = contextItemId ?: id,
        itemType = nodeType.wireValue,
        title = title,
        resourceId = rid,
        organizationId = organizationId,
        isPinned = isPinned,
        updatedAt = updatedAt,
    )
}
