package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	maxUploadFileBytes  = 100 << 20
	maxUploadChunkBytes = 4 << 20
	maxActiveUploads    = 4
	maxUploadTotalBytes = 1 << 30
	uploadSessionTTL    = time.Hour
)

var invalidUploadNameChars = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)

type fileUploadStore struct {
	mu            sync.Mutex
	root          string
	uploads       map[string]*fileUpload
	maxTotalBytes int64
}

type fileUpload struct {
	id        string
	fileName  string
	size      int64
	received  int64
	nextIndex int
	file      *os.File
	tempPath  string
	hasher    hash.Hash
	createdAt time.Time
}

type beginFileUploadResult struct {
	UploadID  string `json:"uploadId"`
	ChunkSize int    `json:"chunkSize"`
	MaxBytes  int64  `json:"maxBytes"`
}

type fileUploadChunkResult struct {
	UploadID string `json:"uploadId"`
	Index    int    `json:"index"`
	Received int64  `json:"received"`
	Size     int64  `json:"size"`
}

type finishedFileUpload struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func (s *CodexLinkService) relayUploadStore() (*fileUploadStore, error) {
	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	if s.uploads != nil {
		return s.uploads, nil
	}
	if strings.TrimSpace(s.uploadRoot) != "" {
		s.uploads = newFileUploadStore(s.uploadRoot)
		return s.uploads, nil
	}
	store, err := newDefaultFileUploadStore()
	if err != nil {
		return nil, err
	}
	s.uploads = store
	return store, nil
}

func (s *CodexLinkService) dispatchFileUploadRPC(method string, params json.RawMessage) (any, error) {
	store, err := s.relayUploadStore()
	if err != nil {
		return nil, err
	}
	switch method {
	case "files.begin":
		var input struct {
			FileName string `json:"fileName"`
			Size     int64  `json:"size"`
		}
		if err := json.Unmarshal(params, &input); err != nil {
			return nil, errors.New("文件上传参数无效")
		}
		return store.Begin(input.FileName, input.Size)
	case "files.chunk":
		var input struct {
			UploadID string `json:"uploadId"`
			Index    int    `json:"index"`
			Data     string `json:"data"`
		}
		if err := json.Unmarshal(params, &input); err != nil {
			return nil, errors.New("文件分块参数无效")
		}
		data, err := base64.StdEncoding.DecodeString(input.Data)
		if err != nil {
			return nil, errors.New("文件分块编码无效")
		}
		return store.Chunk(input.UploadID, input.Index, data)
	case "files.finish":
		var input struct {
			UploadID string `json:"uploadId"`
		}
		if err := json.Unmarshal(params, &input); err != nil {
			return nil, errors.New("完成文件上传参数无效")
		}
		return store.Finish(input.UploadID)
	case "files.cancel":
		var input struct {
			UploadID string `json:"uploadId"`
		}
		if err := json.Unmarshal(params, &input); err != nil {
			return nil, errors.New("取消文件上传参数无效")
		}
		return map[string]bool{"canceled": store.Cancel(input.UploadID)}, nil
	default:
		return nil, errors.New("不支持的文件上传操作")
	}
}

func newDefaultFileUploadStore() (*fileUploadStore, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("无法确定电脑下载目录: %w", err)
	}
	return newFileUploadStore(filepath.Join(home, "Downloads", "CodexLink")), nil
}

func newFileUploadStore(root string) *fileUploadStore {
	return &fileUploadStore{
		root:          root,
		uploads:       make(map[string]*fileUpload),
		maxTotalBytes: maxUploadTotalBytes,
	}
}

func (s *fileUploadStore) Begin(fileName string, size int64) (beginFileUploadResult, error) {
	fileName = strings.TrimSpace(fileName)
	if fileName == "" {
		return beginFileUploadResult{}, errors.New("文件名不能为空")
	}
	if size <= 0 {
		return beginFileUploadResult{}, errors.New("不能上传空文件")
	}
	if size > maxUploadFileBytes {
		return beginFileUploadResult{}, fmt.Errorf("文件不能超过 %d MB", maxUploadFileBytes>>20)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupStaleLocked(time.Now())
	s.cleanupOrphanedPartialsLocked()
	if len(s.uploads) >= maxActiveUploads {
		return beginFileUploadResult{}, errors.New("同时上传的文件过多，请等待其他上传完成")
	}
	if s.maxTotalBytes > 0 && s.usageLocked()+size > s.maxTotalBytes {
		return beginFileUploadResult{}, fmt.Errorf("CodexLink 上传目录已达到 %d MB 上限，请先清理旧文件", s.maxTotalBytes>>20)
	}

	partialDir := filepath.Join(s.root, ".partial")
	if err := os.MkdirAll(partialDir, 0o700); err != nil {
		return beginFileUploadResult{}, fmt.Errorf("无法创建电脑端上传目录: %w", err)
	}
	id := newUploadID()
	temp, err := os.CreateTemp(partialDir, id+"-*.part")
	if err != nil {
		return beginFileUploadResult{}, fmt.Errorf("无法创建电脑端临时文件: %w", err)
	}
	s.uploads[id] = &fileUpload{
		id:        id,
		fileName:  fileName,
		size:      size,
		file:      temp,
		tempPath:  temp.Name(),
		hasher:    sha256.New(),
		createdAt: time.Now(),
	}
	return beginFileUploadResult{
		UploadID:  id,
		ChunkSize: maxUploadChunkBytes,
		MaxBytes:  maxUploadFileBytes,
	}, nil
}

func (s *fileUploadStore) usageLocked() int64 {
	var used int64
	_ = filepath.Walk(s.root, func(path string, info os.FileInfo, err error) error {
		if err == nil && info != nil && info.Mode().IsRegular() {
			used += info.Size()
		}
		return nil
	})
	for _, upload := range s.uploads {
		if remaining := upload.size - upload.received; remaining > 0 {
			used += remaining
		}
	}
	return used
}

func (s *fileUploadStore) Chunk(uploadID string, index int, data []byte) (fileUploadChunkResult, error) {
	uploadID = strings.TrimSpace(uploadID)
	if uploadID == "" {
		return fileUploadChunkResult{}, errors.New("缺少上传 ID")
	}
	if index < 0 {
		return fileUploadChunkResult{}, errors.New("上传分块序号无效")
	}
	if len(data) == 0 {
		return fileUploadChunkResult{}, errors.New("上传分块不能为空")
	}
	if len(data) > maxUploadChunkBytes {
		return fileUploadChunkResult{}, fmt.Errorf("单个上传分块不能超过 %d MB", maxUploadChunkBytes>>20)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	upload := s.uploads[uploadID]
	if upload == nil {
		return fileUploadChunkResult{}, errors.New("上传已失效，请重新选择文件")
	}
	if index != upload.nextIndex {
		return fileUploadChunkResult{}, errors.New("上传分块顺序错误，请重新上传")
	}
	if upload.received+int64(len(data)) > upload.size {
		s.discardLocked(uploadID)
		return fileUploadChunkResult{}, errors.New("上传内容超过文件声明大小")
	}
	written, err := upload.file.Write(data)
	if err != nil || written != len(data) {
		s.discardLocked(uploadID)
		if err == nil {
			err = errors.New("写入文件不完整")
		}
		return fileUploadChunkResult{}, fmt.Errorf("写入电脑端文件失败: %w", err)
	}
	_, _ = upload.hasher.Write(data)
	upload.received += int64(written)
	upload.nextIndex++
	return fileUploadChunkResult{
		UploadID: upload.id,
		Index:    index,
		Received: upload.received,
		Size:     upload.size,
	}, nil
}

func (s *fileUploadStore) Finish(uploadID string) (finishedFileUpload, error) {
	uploadID = strings.TrimSpace(uploadID)
	if uploadID == "" {
		return finishedFileUpload{}, errors.New("缺少上传 ID")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	upload := s.uploads[uploadID]
	if upload == nil {
		return finishedFileUpload{}, errors.New("上传已失效，请重新选择文件")
	}
	if upload.received != upload.size {
		return finishedFileUpload{}, fmt.Errorf("文件尚未传完，已接收 %d / %d 字节", upload.received, upload.size)
	}
	if err := upload.file.Sync(); err != nil {
		s.discardLocked(uploadID)
		return finishedFileUpload{}, fmt.Errorf("同步电脑端文件失败: %w", err)
	}
	if err := upload.file.Close(); err != nil {
		s.discardLocked(uploadID)
		return finishedFileUpload{}, fmt.Errorf("关闭电脑端临时文件失败: %w", err)
	}
	upload.file = nil

	name := safeUploadName(upload.fileName)
	path := s.uniqueDestinationLocked(name)
	if err := os.MkdirAll(s.root, 0o700); err != nil {
		s.discardLocked(uploadID)
		return finishedFileUpload{}, fmt.Errorf("无法创建电脑端下载目录: %w", err)
	}
	if err := os.Rename(upload.tempPath, path); err != nil {
		s.discardLocked(uploadID)
		return finishedFileUpload{}, fmt.Errorf("保存电脑端文件失败: %w", err)
	}
	delete(s.uploads, uploadID)
	return finishedFileUpload{
		Name:   filepath.Base(path),
		Path:   path,
		Size:   upload.received,
		SHA256: hex.EncodeToString(upload.hasher.Sum(nil)),
	}, nil
}

func (s *fileUploadStore) Cancel(uploadID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.discardLocked(strings.TrimSpace(uploadID))
}

func (s *fileUploadStore) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.uploads {
		s.discardLocked(id)
	}
}

func (s *fileUploadStore) discardLocked(uploadID string) bool {
	upload := s.uploads[uploadID]
	if upload == nil {
		return false
	}
	delete(s.uploads, uploadID)
	if upload.file != nil {
		_ = upload.file.Close()
	}
	_ = os.Remove(upload.tempPath)
	return true
}

func (s *fileUploadStore) cleanupStaleLocked(now time.Time) {
	for id, upload := range s.uploads {
		if now.Sub(upload.createdAt) > uploadSessionTTL {
			s.discardLocked(id)
		}
	}
}

func (s *fileUploadStore) cleanupOrphanedPartialsLocked() {
	active := make(map[string]struct{}, len(s.uploads))
	for _, upload := range s.uploads {
		active[upload.tempPath] = struct{}{}
	}
	entries, err := os.ReadDir(filepath.Join(s.root, ".partial"))
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".part") {
			continue
		}
		path := filepath.Join(s.root, ".partial", entry.Name())
		if _, ok := active[path]; ok {
			continue
		}
		_ = os.Remove(path)
	}
}

func (s *fileUploadStore) uniqueDestinationLocked(fileName string) string {
	stamp := time.Now().Format("20060102-150405.000")
	stamp = strings.ReplaceAll(stamp, ".", "-")
	base := filepath.Join(s.root, stamp+"-"+fileName)
	if _, err := os.Stat(base); err != nil {
		return base
	}
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for index := 2; ; index++ {
		candidate := fmt.Sprintf("%s-%d%s", stem, index, ext)
		if _, err := os.Stat(candidate); err != nil {
			return candidate
		}
	}
}

func safeUploadName(raw string) string {
	name := filepath.Base(strings.TrimSpace(raw))
	name = invalidUploadNameChars.ReplaceAllString(name, "_")
	name = strings.Trim(name, " .")
	if name == "" || name == "." || name == ".." {
		name = "upload.bin"
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	if utf8.RuneCountInString(ext) > 32 {
		ext = ""
		stem = name
	}
	if utf8.RuneCountInString(stem) > 120 {
		runes := []rune(stem)
		stem = string(runes[:120])
	}
	if stem == "" {
		stem = "upload"
	}
	return stem + ext
}

func newUploadID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return fmt.Sprintf("upload-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(value[:])
}
