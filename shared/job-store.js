(function attachJobStore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XiaoeJobStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createJobStoreModule() {
  "use strict";

  const draftKey = (draftId) => `batchDraft:${draftId}`;
  const jobKey = (jobId) => `batchJob:${jobId}`;
  const indexKey = (courseId) => `batchJobIndex:${courseId}`;

  function withoutMediaUrls(value) {
    return JSON.parse(JSON.stringify(value, (key, nestedValue) => (
      key === "mediaUrl" ? undefined : nestedValue
    )));
  }

  function createJobStore({ session, local, handleStore }) {
    if (!session || !local || !handleStore) {
      throw new Error("Job store requires session, local, and handleStore adapters");
    }

    async function read(area, key) {
      const values = await area.get(key);
      return values?.[key];
    }

    async function createDraft(draft) {
      if (!draft?.draftId) throw new Error("Draft requires draftId");
      await session.set({ [draftKey(draft.draftId)]: draft });
      return draft;
    }

    async function saveFullJob(job) {
      if (!job?.jobId || !job?.courseId || !job?.fingerprint) throw new Error("Full job identity is incomplete");
      const snapshot = withoutMediaUrls(job);
      await local.set({
        [jobKey(job.jobId)]: snapshot,
        [indexKey(job.courseId)]: { jobId: snapshot.jobId, fingerprint: snapshot.fingerprint },
      });
      return job;
    }

    async function saveCheckpoint(job) {
      if (!job?.jobId) throw new Error("Checkpoint requires jobId");
      await local.set({ [jobKey(job.jobId)]: withoutMediaUrls(job) });
      return job;
    }

    async function findResumeJob(courseId, fingerprint) {
      const index = await read(local, indexKey(courseId));
      if (!index || index.fingerprint !== fingerprint) return null;
      const job = await read(local, jobKey(index.jobId));
      if (!job || job.courseId !== courseId || job.fingerprint !== fingerprint) return null;
      const complete = Array.isArray(job.tasks) && job.tasks.every((task) => ["success", "skipped"].includes(task.status));
      return complete ? null : job;
    }

    async function deleteJob(jobId) {
      const key = jobKey(jobId);
      const job = await read(local, key);
      if (!job) return false;

      const keys = [key];
      if (job.courseId) {
        const courseIndexKey = indexKey(job.courseId);
        const index = await read(local, courseIndexKey);
        if (index?.jobId === jobId) keys.push(courseIndexKey);
      }
      if (job.directoryHandleId) await handleStore.delete(job.directoryHandleId);
      await local.remove(keys);
      return true;
    }

    return { createDraft, deleteJob, findResumeJob, saveCheckpoint, saveFullJob };
  }

  return { createJobStore };
});
