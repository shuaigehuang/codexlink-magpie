package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileUploadStoreWritesChunksToDownloads(t *testing.T) {
	root := t.TempDir()
	store := newFileUploadStore(root)
	content := []byte("phone upload content")
	begin, err := store.Begin(`..\报告:最终?.txt`, int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	if begin.UploadID == "" || begin.ChunkSize != maxUploadChunkBytes {
		t.Fatalf("unexpected begin result: %+v", begin)
	}
	if _, err := store.Chunk(begin.UploadID, 0, content[:6]); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Chunk(begin.UploadID, 1, content[6:]); err != nil {
		t.Fatal(err)
	}
	finished, err := store.Finish(begin.UploadID)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(finished.Path) != root {
		t.Fatalf("saved outside upload root: %s", finished.Path)
	}
	if strings.Contains(filepath.Base(finished.Path), "..") {
		t.Fatalf("unsafe file name survived sanitization: %s", finished.Path)
	}
	got, err := os.ReadFile(finished.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("saved content = %q, want %q", got, content)
	}
	sum := sha256.Sum256(content)
	if finished.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("sha256 = %s", finished.SHA256)
	}
}

func TestFileUploadStoreRejectsMissingAndOutOfOrderChunks(t *testing.T) {
	store := newFileUploadStore(t.TempDir())
	begin, err := store.Begin("test.bin", 5)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Chunk(begin.UploadID, 0, []byte("ab")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Chunk(begin.UploadID, 2, []byte("cd")); err == nil {
		t.Fatal("out-of-order chunk was accepted")
	}
	if _, err := store.Finish(begin.UploadID); err == nil {
		t.Fatal("incomplete upload was finished")
	}
	if !store.Cancel(begin.UploadID) {
		t.Fatal("upload session was not canceled")
	}
	if store.Cancel(begin.UploadID) {
		t.Fatal("cancel was not idempotent")
	}
}

func TestFileUploadStoreEnforcesLimits(t *testing.T) {
	store := newFileUploadStore(t.TempDir())
	if _, err := store.Begin("", 1); err == nil {
		t.Fatal("empty file name was accepted")
	}
	if _, err := store.Begin("empty.txt", 0); err == nil {
		t.Fatal("empty file was accepted")
	}
	if _, err := store.Begin("large.bin", maxUploadFileBytes+1); err == nil {
		t.Fatal("oversized file was accepted")
	}
}

func TestFileUploadStoreEnforcesTotalQuota(t *testing.T) {
	store := newFileUploadStore(t.TempDir())
	t.Cleanup(store.Close)
	store.maxTotalBytes = 8
	if _, err := store.Begin("first.bin", 5); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Begin("second.bin", 4); err == nil {
		t.Fatal("upload exceeded the total disk quota")
	}
}

func TestSafeUploadNameFallsBackForTraversal(t *testing.T) {
	if got := safeUploadName(".."); got == ".." || got == "." || got == "" {
		t.Fatalf("unsafe fallback name: %q", got)
	}
	if got := safeUploadName(`C:\temp\a<b>.txt`); strings.ContainsAny(got, `<>:"/\\|?*`) {
		t.Fatalf("unsafe characters survived: %q", got)
	}
}
