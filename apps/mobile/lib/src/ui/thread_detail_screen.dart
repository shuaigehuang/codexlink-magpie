import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:material_ui/material_ui.dart';

import '../mobile_controller.dart';
import '../models.dart';
import '../relay_client.dart';
import '../theme.dart';
import 'widgets.dart';

class ThreadDetailScreen extends StatefulWidget {
  const ThreadDetailScreen({
    super.key,
    required this.controller,
    required this.thread,
  });

  final MobileController controller;
  final ThreadBrief thread;

  @override
  State<ThreadDetailScreen> createState() => _ThreadDetailScreenState();
}

class _ThreadDetailScreenState extends State<ThreadDetailScreen>
    with WidgetsBindingObserver {
  final TextEditingController _composer = TextEditingController();
  final ScrollController _scroll = ScrollController();
  ThreadDetail? _detail;
  String? _error;
  bool _loading = true;
  bool _sending = false;
  bool _uploading = false;
  double _uploadProgress = 0;
  String _uploadingFileName = '';
  UploadedFile? _pendingUpload;
  bool _waitingReply = false;
  bool _showJumpToBottom = false;
  bool _pollingLive = false;
  bool _appActive = true;
  int _latestTimestamp = 0;
  Timer? _liveTimer;
  bool _wasConnected = false;
  late bool _collapseCommands;
  final Map<String, bool> _commandExpanded = <String, bool>{};
  final Map<String, bool> _reasoningExpanded = <String, bool>{};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _collapseCommands = widget.controller.collapseCommands;
    _wasConnected = widget.controller.connected;
    widget.controller.addListener(_handleControllerChange);
    _scroll.addListener(_handleScroll);
    _load(scrollToBottom: true);
    _liveTimer = Timer.periodic(
      const Duration(milliseconds: 500),
      (_) => unawaited(_pollLive()),
    );
  }

  @override
  void dispose() {
    _liveTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_handleControllerChange);
    _scroll.removeListener(_handleScroll);
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _appActive = state == AppLifecycleState.resumed;
    if (_appActive) {
      unawaited(_load(scrollToBottom: true));
    }
  }

  void _handleControllerChange() {
    final collapsed = widget.controller.collapseCommands;
    final connected = widget.controller.connected;
    final reconnected = connected && !_wasConnected;
    _wasConnected = connected;
    if (collapsed != _collapseCommands && mounted) {
      setState(() {
        _collapseCommands = collapsed;
        _commandExpanded.clear();
      });
    }
    if (reconnected && mounted) {
      unawaited(_load(scrollToBottom: true));
    }
  }

  void _handleScroll() {
    if (!_scroll.hasClients) {
      return;
    }
    final show = _scroll.offset > 240;
    if (show != _showJumpToBottom && mounted) {
      setState(() => _showJumpToBottom = show);
    }
  }

  bool _isCommandExpanded(String key) {
    return _commandExpanded[key] ?? !_collapseCommands;
  }

  void _toggleCommand(String key) {
    setState(() => _commandExpanded[key] = !_isCommandExpanded(key));
  }

  bool _isReasoningExpanded(ThreadItem item) {
    final expanded = _reasoningExpanded[item.id];
    return expanded ?? !item.completed;
  }

  void _toggleReasoning(String key, bool current) {
    setState(() => _reasoningExpanded[key] = !current);
  }

  Future<void> _pickAndUpload() async {
    if (_uploading || _sending) {
      return;
    }
    try {
      final selected = await FilePicker.pickFile();
      if (selected == null || !mounted) {
        return;
      }
      final selectedPath = selected.path;
      if (selectedPath == null || selectedPath.isEmpty) {
        throw const RelayException('无法读取所选文件路径，请重新选择');
      }
      final file = File(selectedPath);
      if (!await file.exists()) {
        throw const RelayException('无法读取所选文件，请重新选择');
      }
      final size = await file.length();
      if (!mounted) {
        return;
      }
      if (size > maxUploadFileBytes) {
        showMessage(context, '文件不能超过 100 MB', error: true);
        return;
      }
      final fileName = selected.name.trim().isEmpty
          ? 'upload.bin'
          : selected.name.trim();
      setState(() {
        _uploading = true;
        _uploadProgress = 0;
        _uploadingFileName = fileName;
      });
      final uploaded = await widget.controller.uploadFile(
        file,
        fileName,
        onProgress: (progress) {
          if (mounted) {
            setState(() => _uploadProgress = progress);
          }
        },
      );
      if (!mounted) {
        return;
      }
      setState(() {
        _pendingUpload = uploaded;
        _uploadProgress = 1;
      });
      showMessage(context, '文件已上传到电脑，发送指令时会继续当前会话');
    } catch (exception) {
      if (mounted) {
        showMessage(context, friendlyError(exception), error: true);
      }
    } finally {
      if (mounted) {
        setState(() {
          _uploading = false;
          _uploadingFileName = '';
          if (_pendingUpload == null) {
            _uploadProgress = 0;
          }
        });
      }
    }
  }

  Future<void> _load({bool scrollToBottom = false}) async {
    if (mounted) {
      setState(() {
        _loading = _detail == null;
        _error = null;
      });
    }
    try {
      final detail = await widget.controller.readThread(widget.thread.id);
      if (!mounted) {
        return;
      }
      setState(() {
        _detail = detail;
        _error = null;
        _latestTimestamp = _newestTimestamp(
          detail.items,
          detail.latestTimestamp,
        );
      });
      if (scrollToBottom) {
        _scrollToBottom();
      }
    } catch (exception) {
      if (mounted) {
        setState(() => _error = friendlyError(exception));
      }
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _pollLive() async {
    if (!mounted ||
        !_appActive ||
        _loading ||
        _pollingLive ||
        !widget.controller.connected ||
        _detail == null) {
      return;
    }
    _pollingLive = true;
    try {
      final update = await widget.controller.readThread(
        widget.thread.id,
        sinceTimestamp: _latestTimestamp,
      );
      if (!mounted || update.items.isEmpty) {
        return;
      }
      final current = _detail!;
      final merged = mergeThreadItems(current.items, update.items);
      if (_sameThreadItems(current.items, merged)) {
        return;
      }
      final followBottom = !_scroll.hasClients || _scroll.offset < 96;
      final nextLatest = _newestTimestamp(update.items, _latestTimestamp);
      setState(() {
        _detail = ThreadDetail(
          thread: update.thread.name.isEmpty ? current.thread : update.thread,
          items: merged,
          turns: update.turns > 0 ? update.turns : current.turns,
          latestTimestamp: nextLatest,
        );
        _latestTimestamp = nextLatest;
      });
      if (followBottom) {
        _scrollToBottom();
      }
    } catch (_) {
      // Transient polling failures are retried on the next interval.
    } finally {
      _pollingLive = false;
    }
  }

  void _scrollToBottom({bool animated = false}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) {
        return;
      }
      if (animated) {
        _scroll.animateTo(
          0,
          duration: const Duration(milliseconds: 260),
          curve: Curves.easeOut,
        );
      } else {
        _scroll.jumpTo(0);
      }
    });
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    final upload = _pendingUpload;
    if ((text.isEmpty && upload == null) || _sending || _uploading) {
      return;
    }
    final messageText = upload == null
        ? text
        : text.isEmpty
        ? '手机上传的文件已保存到电脑：${upload.path}\n请查看这个文件。'
        : '手机上传的文件已保存到电脑：${upload.path}\n\n$text';
    setState(() {
      _sending = true;
      _waitingReply = true;
    });
    var waitNoticeShown = false;
    try {
      var attempt = 0;
      SendResult? sent;
      while (true) {
        try {
          sent = await widget.controller.sendMessage(
            widget.thread.id,
            messageText,
          );
          break;
        } catch (exception) {
          final busy = exception.toString().contains('thread_busy');
          if (!busy || attempt >= 39) {
            rethrow;
          }
          attempt += 1;
          if (!waitNoticeShown && mounted) {
            waitNoticeShown = true;
            showMessage(context, '电脑端正在使用这个会话，请在电脑上切换到其他会话；正在自动等待，不会新建会话');
          }
          await Future<void>.delayed(const Duration(seconds: 3));
        }
      }
      _composer.clear();
      if (mounted) {
        setState(() {
          _pendingUpload = null;
          _uploadProgress = 0;
        });
      }
      if (mounted) {
        showMessage(
          context,
          sent.status == 'queued'
              ? '指令已加入电脑端会话队列，将在当前任务结束后继续执行'
              : '指令已发送到当前会话，正在等待 Codex 回复',
        );
      }
      await Future<void>.delayed(const Duration(milliseconds: 350));
      await _pollLive();
    } catch (exception) {
      if (mounted) {
        showMessage(context, friendlyError(exception), error: true);
      }
    } finally {
      if (mounted) {
        setState(() {
          _sending = false;
          _waitingReply = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _detail?.items ?? const <ThreadItem>[];
    final rows = _buildRows(items);
    return Scaffold(
      appBar: AppBar(
        title: Text(
          _detail?.thread.name ?? widget.thread.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        actions: [
          IconButton(
            tooltip: '刷新回复',
            onPressed: _loading ? null : () => _load(scrollToBottom: true),
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: Stack(
              fit: StackFit.expand,
              children: [
                _loading
                    ? const Center(child: CircularProgressIndicator())
                    : _error != null && items.isEmpty
                    ? EmptyState(
                        icon: Icons.cloud_off_rounded,
                        title: '读取会话失败',
                        message: _error!,
                        action: FilledButton(
                          onPressed: () => _load(scrollToBottom: true),
                          child: const Text('重新加载'),
                        ),
                      )
                    : ListView.builder(
                        controller: _scroll,
                        reverse: true,
                        padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
                        itemCount: rows.isEmpty ? 1 : rows.length,
                        itemBuilder: (context, index) {
                          if (rows.isEmpty) {
                            return SizedBox(
                              height: MediaQuery.sizeOf(context).height * 0.55,
                              child: const Center(
                                child: EmptyState(
                                  icon: Icons.hourglass_empty_rounded,
                                  title: '这个会话还没有消息',
                                  message: '在下方输入指令，开始新的对话。',
                                ),
                              ),
                            );
                          }
                          final row = rows[rows.length - 1 - index];
                          if (!row.isCommand) {
                            if (row.isReasoning) {
                              final item = row.items.first;
                              final reasoningKey = item.id.isEmpty
                                  ? 'reasoning-${row.startIndex}'
                                  : 'reasoning-${item.id}';
                              final expanded = _isReasoningExpanded(item);
                              return _ReasoningBlock(
                                item: item,
                                expanded: expanded,
                                onToggle: () =>
                                    _toggleReasoning(reasoningKey, expanded),
                              );
                            }
                            return _MessageBubble(item: row.items.first);
                          }
                          final commandKey = row.items.first.id.isEmpty
                              ? 'group-${row.startIndex}'
                              : 'group-${row.items.first.id}';
                          return _CommandBlock(
                            items: row.items,
                            expanded: _isCommandExpanded(commandKey),
                            onToggle: () => _toggleCommand(commandKey),
                          );
                        },
                      ),
                Positioned(
                  right: 14,
                  bottom: 14,
                  child: AnimatedOpacity(
                    duration: const Duration(milliseconds: 160),
                    opacity: _showJumpToBottom ? 1 : 0,
                    child: IgnorePointer(
                      ignoring: !_showJumpToBottom,
                      child: _JumpToBottomButton(
                        onTap: () => _scrollToBottom(animated: true),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          if (_waitingReply)
            const LinearProgressIndicator(
              minHeight: 2,
              backgroundColor: Colors.transparent,
            ),
          _Composer(
            controller: _composer,
            sending: _sending || _uploading,
            uploading: _uploading,
            uploadProgress: _uploadProgress,
            uploadingFileName: _uploadingFileName,
            attachedFile: _pendingUpload,
            onPickFile: _pickAndUpload,
            onRemoveAttachment: () {
              setState(() {
                _pendingUpload = null;
                _uploadProgress = 0;
              });
            },
            onSend: _send,
          ),
        ],
      ),
    );
  }
}

class _ThreadRow {
  _ThreadRow(this.items, this.startIndex);

  final List<ThreadItem> items;
  final int startIndex;

  bool get isCommand => items.isNotEmpty && items.first.isCommand;
  bool get isReasoning => items.isNotEmpty && items.first.isReasoning;
}

List<_ThreadRow> _buildRows(List<ThreadItem> items) {
  final rows = <_ThreadRow>[];
  var index = 0;
  while (index < items.length) {
    if (items[index].isReasoning) {
      rows.add(_ThreadRow(<ThreadItem>[items[index]], index));
      index += 1;
      continue;
    }
    if (!items[index].isCommand) {
      rows.add(_ThreadRow(<ThreadItem>[items[index]], index));
      index += 1;
      continue;
    }
    final start = index;
    final group = <ThreadItem>[];
    while (index < items.length && items[index].isCommand) {
      group.add(items[index]);
      index += 1;
    }
    rows.add(_ThreadRow(group, start));
  }
  return rows;
}

int _newestTimestamp(List<ThreadItem> items, int fallback) {
  var newest = fallback;
  for (final item in items) {
    if (item.timestamp > newest) {
      newest = item.timestamp;
    }
  }
  return newest;
}

bool _sameThreadItems(List<ThreadItem> current, List<ThreadItem> next) {
  if (current.length != next.length) {
    return false;
  }
  for (var index = 0; index < current.length; index += 1) {
    final left = current[index];
    final right = next[index];
    if (left.id != right.id ||
        left.type != right.type ||
        left.text != right.text ||
        left.command != right.command ||
        left.output != right.output ||
        left.timestamp != right.timestamp ||
        left.completed != right.completed) {
      return false;
    }
  }
  return true;
}

class _ReasoningBlock extends StatelessWidget {
  const _ReasoningBlock({
    required this.item,
    required this.expanded,
    required this.onToggle,
  });

  final ThreadItem item;
  final bool expanded;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: const Color(0xFF15131C),
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: const Color(0xFF3A3348)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: onToggle,
            borderRadius: BorderRadius.circular(13),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              child: Row(
                children: [
                  const Icon(
                    Icons.psychology_alt_rounded,
                    size: 17,
                    color: Color(0xFFBCA8FF),
                  ),
                  const SizedBox(width: 7),
                  const Text(
                    '思考过程',
                    style: TextStyle(
                      color: Color(0xFFCFC5E8),
                      fontSize: 13.5,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    item.completed ? '已完成' : '进行中',
                    style: TextStyle(
                      color: item.completed
                          ? const Color(0xFF756D86)
                          : const Color(0xFFBCA8FF),
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  Text(
                    expanded ? '收起' : '展开',
                    style: const TextStyle(
                      color: Color(0xFF8D839F),
                      fontSize: 12.5,
                    ),
                  ),
                  const SizedBox(width: 2),
                  Icon(
                    expanded
                        ? Icons.expand_less_rounded
                        : Icons.expand_more_rounded,
                    size: 19,
                    color: const Color(0xFF8D839F),
                  ),
                ],
              ),
            ),
          ),
          if (expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(13, 0, 13, 12),
              child: SelectableText(
                item.text,
                style: const TextStyle(
                  color: Color(0xFFBDB5CE),
                  fontSize: 14.5,
                  height: 1.55,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _CommandBlock extends StatelessWidget {
  const _CommandBlock({
    required this.items,
    required this.expanded,
    required this.onToggle,
  });

  final List<ThreadItem> items;
  final bool expanded;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final hasOutput = items.any((item) => item.output.isNotEmpty);
    final label = items.length > 1 ? '电脑命令 ×${items.length}' : '电脑命令';
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 6),
      decoration: BoxDecoration(
        color: const Color(0xFF10171E),
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: const Color(0xFF293543)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: onToggle,
            borderRadius: BorderRadius.circular(13),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              child: Row(
                children: [
                  const Icon(
                    Icons.terminal_rounded,
                    size: 16,
                    color: Color(0xFF8D9BAB),
                  ),
                  const SizedBox(width: 7),
                  Text(
                    label,
                    style: const TextStyle(
                      color: Color(0xFF8D9BAB),
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (!expanded && hasOutput) ...[
                    const SizedBox(width: 8),
                    const Text(
                      '有输出',
                      style: TextStyle(color: Color(0xFF5F7183), fontSize: 12),
                    ),
                  ],
                  const Spacer(),
                  Text(
                    expanded ? '收起' : '展开',
                    style: const TextStyle(
                      color: Color(0xFF7C8C9C),
                      fontSize: 12.5,
                    ),
                  ),
                  const SizedBox(width: 2),
                  Icon(
                    expanded
                        ? Icons.expand_less_rounded
                        : Icons.expand_more_rounded,
                    size: 19,
                    color: const Color(0xFF7C8C9C),
                  ),
                ],
              ),
            ),
          ),
          if (expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 11),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (var i = 0; i < items.length; i += 1) ...[
                    if (i > 0)
                      const Divider(height: 18, color: Color(0xFF243140)),
                    SelectableText(
                      '\$ ${items[i].command}',
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 14,
                        height: 1.45,
                        color: Color(0xFFB8F1E3),
                      ),
                    ),
                    if (items[i].output.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      SelectableText(
                        items[i].output,
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 13,
                          height: 1.45,
                          color: Color(0xFFA8B4C1),
                        ),
                      ),
                    ],
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _JumpToBottomButton extends StatelessWidget {
  const _JumpToBottomButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: const Color(0xFF1B2733),
      elevation: 6,
      shadowColor: Colors.black54,
      borderRadius: BorderRadius.circular(22),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(22),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(22),
            border: Border.all(color: const Color(0xFF33465A)),
          ),
          child: const Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.arrow_downward_rounded,
                size: 18,
                color: Color(0xFFB8F1E3),
              ),
              SizedBox(width: 6),
              Text(
                '到底部',
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: Color(0xFFE6F1F5),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.item});

  final ThreadItem item;

  @override
  Widget build(BuildContext context) {
    final isUser = item.isUser;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.84,
        ),
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.all(15),
        decoration: BoxDecoration(
          color: isUser ? const Color(0xFF1E594E) : const Color(0xFF19222B),
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(18),
            topRight: const Radius.circular(18),
            bottomLeft: Radius.circular(isUser ? 18 : 5),
            bottomRight: Radius.circular(isUser ? 5 : 18),
          ),
          border: Border.all(
            color: isUser ? const Color(0xFF327767) : const Color(0xFF2A3541),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              isUser ? '你' : 'Codex',
              style: TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w700,
                color: isUser ? const Color(0xFFB7F4E3) : brandColor,
              ),
            ),
            const SizedBox(height: 6),
            SelectableText(
              item.text,
              style: const TextStyle(fontSize: 16.5, height: 1.52),
            ),
          ],
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.sending,
    required this.uploading,
    required this.uploadProgress,
    required this.uploadingFileName,
    required this.attachedFile,
    required this.onPickFile,
    required this.onRemoveAttachment,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool sending;
  final bool uploading;
  final double uploadProgress;
  final String uploadingFileName;
  final UploadedFile? attachedFile;
  final VoidCallback onPickFile;
  final VoidCallback onRemoveAttachment;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
        decoration: const BoxDecoration(
          color: Color(0xFF10171E),
          border: Border(top: BorderSide(color: Color(0xFF26313D))),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (uploading || attachedFile != null) ...[
              _AttachmentPanel(
                uploading: uploading,
                progress: uploadProgress,
                uploadingFileName: uploadingFileName,
                file: attachedFile,
                onRemove: onRemoveAttachment,
              ),
              const SizedBox(height: 9),
            ],
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                SizedBox(
                  width: 50,
                  height: 54,
                  child: OutlinedButton(
                    onPressed: sending ? null : onPickFile,
                    style: OutlinedButton.styleFrom(
                      padding: EdgeInsets.zero,
                      side: const BorderSide(color: Color(0xFF344252)),
                    ),
                    child: uploading
                        ? SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(
                              strokeWidth: 2.4,
                              value: uploadProgress <= 0
                                  ? null
                                  : uploadProgress,
                            ),
                          )
                        : const Icon(Icons.attach_file_rounded, size: 23),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: controller,
                    minLines: 1,
                    maxLines: 5,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: InputDecoration(
                      hintText: attachedFile == null
                          ? '发送指令给 Codex…'
                          : '补充说明，或直接发送文件…',
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 13,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 54,
                  height: 54,
                  child: FilledButton(
                    onPressed: sending ? null : onSend,
                    style: FilledButton.styleFrom(padding: EdgeInsets.zero),
                    child: sending
                        ? const SizedBox(
                            width: 21,
                            height: 21,
                            child: CircularProgressIndicator(strokeWidth: 2.4),
                          )
                        : const Icon(Icons.arrow_upward_rounded),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _AttachmentPanel extends StatelessWidget {
  const _AttachmentPanel({
    required this.uploading,
    required this.progress,
    required this.uploadingFileName,
    required this.file,
    required this.onRemove,
  });

  final bool uploading;
  final double progress;
  final String uploadingFileName;
  final UploadedFile? file;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final uploaded = file;
    final percent = (progress * 100).clamp(0, 100).round();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: BoxDecoration(
        color: const Color(0xFF151F28),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFF304152)),
      ),
      child: Row(
        children: [
          Icon(
            uploading ? Icons.cloud_upload_rounded : Icons.check_circle_rounded,
            size: 24,
            color: uploading ? const Color(0xFFFFB65C) : brandColor,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  uploading
                      ? '正在上传到电脑 · $percent%'
                      : '已上传到电脑 · ${_formatFileSize(uploaded!.size)}',
                  style: const TextStyle(
                    fontSize: 14.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  uploading ? uploadingFileName : uploaded!.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 13.5,
                    color: Color(0xFFA9B6C4),
                  ),
                ),
                if (!uploading && uploaded != null) ...[
                  const SizedBox(height: 3),
                  Text(
                    uploaded.path,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 12,
                      height: 1.3,
                      color: Color(0xFF7F91A3),
                    ),
                  ),
                ],
                if (uploading) ...[
                  const SizedBox(height: 7),
                  LinearProgressIndicator(
                    minHeight: 4,
                    value: progress <= 0 ? null : progress,
                    borderRadius: BorderRadius.circular(4),
                  ),
                ],
              ],
            ),
          ),
          if (!uploading)
            IconButton(
              tooltip: '从待发送中移除，电脑上的文件不会删除',
              onPressed: onRemove,
              icon: const Icon(Icons.close_rounded, size: 20),
            ),
        ],
      ),
    );
  }
}

String _formatFileSize(int bytes) {
  if (bytes >= 1024 * 1024) {
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
  if (bytes >= 1024) {
    return '${(bytes / 1024).toStringAsFixed(1)} KB';
  }
  return '$bytes B';
}
