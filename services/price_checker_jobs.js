const jobsById = new Map();

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

function now() {
  return new Date();
}

function createJobId() {
  return `pc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createSnapshot(job) {
  const totalRows = Number(job.total_rows || 0);
  const processedRows = Number(job.processed_rows || 0);
  const percent =
    totalRows > 0
      ? Math.min(100, Math.round((processedRows / totalRows) * 100))
      : 0;

  return {
    job_id: job.id,
    status: job.status,
    stage: job.stage,
    message: job.message,
    input_rows: job.input_rows ?? 0,
    total_rows: totalRows,
    processed_rows: processedRows,
    skipped_invalid_rows: job.skipped_invalid_rows ?? 0,
    inserted: job.inserted ?? null,
    percent,
    error: job.error ?? null,
    started_at: job.started_at,
    updated_at: job.updated_at,
  };
}

function createJob({ input_rows, total_rows, skipped_invalid_rows = 0 }) {
  const id = createJobId();
  const job = {
    id,
    status: "pending",
    stage: "queued",
    message: "Upload queued",
    input_rows,
    total_rows,
    processed_rows: 0,
    skipped_invalid_rows,
    inserted: null,
    error: null,
    started_at: now(),
    updated_at: now(),
  };
  jobsById.set(id, job);
  return job;
}

function getJob(jobId) {
  return jobsById.get(jobId) || null;
}

function updateJob(jobId, patch) {
  const job = jobsById.get(jobId);
  if (!job) return null;
  Object.assign(job, patch, { updated_at: now() });
  return job;
}

function getJobStatus(jobId) {
  const job = getJob(jobId);
  if (!job) {
    return { code: 404, msg: "Job not found or expired" };
  }

  const snapshot = createSnapshot(job);

  if (TERMINAL_STATUSES.has(job.status)) {
    jobsById.delete(jobId);
  }

  return { code: 200, ...snapshot };
}

module.exports = {
  createJob,
  getJob,
  updateJob,
  getJobStatus,
  createSnapshot,
};
