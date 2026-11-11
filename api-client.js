/**
 * Exploitative Leadership Detection Web API Client
 * Provides web-native replacements for Electron IPC & Node filesystem operations
 */
(function () {
  const API_BASE = "";

  async function request(url, options = {}) {
    const defaultHeaders = {};
    if (options.body && !(options.body instanceof FormData)) {
      defaultHeaders["Content-Type"] = "application/json";
    }

    const response = await fetch(API_BASE + url, {
      ...options,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      let errorMessage = "Request failed (" + response.status + ")";
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch (_e) {
        // Fallback to text if JSON parsing fails
        const text = await response.text();
        if (text) errorMessage = text;
      }
      throw new Error(errorMessage);
    }

    return response.json();
  }

  const apiClient = {
    // Settings
    async getSettings() {
      return request("/api/settings");
    },

    async saveSettings(settings) {
      return request("/api/settings", {
        method: "POST",
        body: JSON.stringify(settings),
      });
    },

    // AI Analysis
    async analyze(text, biometrics = null) {
      return request("/api/analyze", {
        method: "POST",
        body: JSON.stringify({ text, biometrics }),
      });
    },

    // Non-Exploitative Autocomplete
    async getAutocomplete(text) {
      return request("/api/autocomplete", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    },

    // Pronoun & Egoistic Bias Evaluation
    async getPronounBias(text) {
      return request("/api/bias/pronouns", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    },

    // Training & Course Recommendations
    async getTrainingRecommendations(context = {}) {
      return request("/api/training/recommendations", {
        method: "POST",
        body: JSON.stringify(context),
      });
    },

    // Excel Logging & Summary
    async getExcelSummary() {
      return request("/api/excel/summary");
    },

    async appendComposeResult(composeResult, options = {}) {
      return request("/api/excel/append", {
        method: "POST",
        body: JSON.stringify({ composeResult, options }),
      });
    },

    async updateComposeRewrite(rowNumber, rewrite) {
      return request("/api/excel/rewrite", {
        method: "POST",
        body: JSON.stringify({ rowNumber, rewrite }),
      });
    },

    // File Downloads & Uploads
    downloadExcel() {
      const downloadLink = document.createElement("a");
      downloadLink.href = "/api/excel/download?t=" + Date.now();
      downloadLink.setAttribute("download", "Exploitative-Leadership-Compose-Log.xlsx");
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
    },

    async uploadExcel(file) {
      const formData = new FormData();
      formData.append("file", file);
      return request("/api/excel/upload", {
        method: "POST",
        body: formData,
      });
    },

    async uploadPst(file) {
      const formData = new FormData();
      formData.append("file", file);
      return request("/api/pst/upload", {
        method: "POST",
        body: formData,
      });
    },

    async exportResults(results) {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ results }),
      });

      if (!response.ok) {
        throw new Error("Failed to export results");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Exploitative-Leadership-Export.xlsx";
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    },

    // Biometrics
    async pairWatch() {
      return request("/api/biometrics/pair", { method: "POST" });
    },

    async getBiometrics(sessionId) {
      return request(`/api/biometrics/current?sessionId=${encodeURIComponent(sessionId)}`);
    }
  };

  window.apiClient = apiClient;
})();

