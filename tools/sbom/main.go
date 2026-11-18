package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

type module struct {
	Path    string
	Version string
	Main    bool
	Replace *module
}

type property struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type component struct {
	Type       string     `json:"type"`
	Name       string     `json:"name"`
	Version    string     `json:"version,omitempty"`
	PURL       string     `json:"purl,omitempty"`
	Properties []property `json:"properties,omitempty"`
}

type toolComponent struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

type metadata struct {
	Timestamp string    `json:"timestamp"`
	Component component `json:"component"`
	Tools     struct {
		Components []toolComponent `json:"components"`
	} `json:"tools"`
}

type bom struct {
	BOMFormat    string      `json:"bomFormat"`
	SpecVersion  string      `json:"specVersion"`
	SerialNumber string      `json:"serialNumber"`
	Version      int         `json:"version"`
	Metadata     metadata    `json:"metadata"`
	Components   []component `json:"components"`
}

func main() {
	dir := flag.String("dir", ".", "module directory to inspect")
	output := flag.String("output", "sbom.json", "output file, or - for stdout")
	name := flag.String("name", "codexlink", "main component name")
	version := flag.String("version", "devel", "main component version")
	flag.Parse()

	modules, err := listModules(*dir)
	if err != nil {
		fail(err)
	}
	doc, err := buildBOM(*name, *version, modules)
	if err != nil {
		fail(err)
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		fail(err)
	}
	data = append(data, '\n')
	if *output == "-" {
		if _, err := os.Stdout.Write(data); err != nil {
			fail(err)
		}
		return
	}
	if err := os.WriteFile(*output, data, 0o644); err != nil {
		fail(err)
	}
}

func listModules(dir string) ([]module, error) {
	cmd := exec.Command("go", "list", "-m", "-json", "all")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("go list -m -json all: %w", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(out)))
	var modules []module
	for decoder.More() {
		var item module
		if err := decoder.Decode(&item); err != nil {
			return nil, fmt.Errorf("decode go list output: %w", err)
		}
		modules = append(modules, item)
	}
	return modules, nil
}

func buildBOM(name, version string, modules []module) (bom, error) {
	serial, err := serialNumber()
	if err != nil {
		return bom{}, err
	}
	doc := bom{
		BOMFormat:    "CycloneDX",
		SpecVersion:  "1.6",
		SerialNumber: serial,
		Version:      1,
		Components:   []component{},
	}
	doc.Metadata.Timestamp = time.Now().UTC().Format(time.RFC3339)
	doc.Metadata.Component = component{
		Type:    "application",
		Name:    name,
		Version: version,
	}
	doc.Metadata.Tools.Components = []toolComponent{{Type: "application", Name: "codexlink-sbom"}}

	seen := make(map[string]bool)
	for _, item := range modules {
		path, modVersion := item.Path, item.Version
		properties := []property(nil)
		if item.Replace != nil {
			if item.Replace.Path != "" {
				properties = append(properties, property{Name: "codexlink:original-path", Value: path})
			}
			if item.Replace.Version != "" {
				properties = append(properties, property{Name: "codexlink:original-version", Value: modVersion})
			}
			path, modVersion = item.Replace.Path, item.Replace.Version
		}
		if path == "" || path == item.Path && item.Main {
			continue
		}
		key := path + "@" + modVersion
		if seen[key] {
			continue
		}
		seen[key] = true
		doc.Components = append(doc.Components, component{
			Type:       "library",
			Name:       path,
			Version:    modVersion,
			PURL:       purl(path, modVersion),
			Properties: properties,
		})
	}
	sort.Slice(doc.Components, func(i, j int) bool {
		if doc.Components[i].Name == doc.Components[j].Name {
			return doc.Components[i].Version < doc.Components[j].Version
		}
		return doc.Components[i].Name < doc.Components[j].Name
	})
	return doc, nil
}

func purl(path, version string) string {
	value := "pkg:golang/" + percentEncode(path)
	if version != "" {
		value += "@" + percentEncode(version)
	}
	return value
}

func percentEncode(value string) string {
	var builder strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			builder.WriteRune(r)
		case strings.ContainsRune("-._~:/@", r):
			builder.WriteRune(r)
		default:
			fmt.Fprintf(&builder, "%%%02X", r)
		}
	}
	return builder.String()
}

func serialNumber() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate serial number: %w", err)
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	encoded := hex.EncodeToString(raw[:])
	return fmt.Sprintf("urn:uuid:%s-%s-%s-%s-%s", encoded[0:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:32]), nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
