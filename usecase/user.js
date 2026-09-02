const jwt = require("../services/jwt");
const {
  isAccessAllowed,
  normalizeIpPolicy,
  parseAllowList,
  resolveIpPolicy,
  toBoolean,
  validateIpPolicy,
} = require("../utils/ip");
// const SMS = require("../services/sms");

/** Returned when a valid login is refused because of where it came from. */
const IP_NOT_ALLOWED = {
  code: 403,
  error: "IP_NOT_ALLOWED",
  msg: "This account can only be used from an approved network.",
};

class UserUsecase {
  constructor(userRepo, designationRepo, employeeRepo) {
    this.userRepo = userRepo;
    this.designationRepo = designationRepo;
    this.employeeRepo = employeeRepo;
  }

  /**
   * Sign in.
   *
   * `clientIp` is the address the request came from. The user's own policy
   * and their branch's rule are folded together (`resolveIpPolicy`); a login
   * from outside the resulting addresses is refused even though the
   * credentials are correct.
   */
  login(username, password, clientIp) {
    return new Promise(async (resolve, reject) => {
      try {
        const details = await this.userRepo.login(username, password);
        const name = await this.employeeRepo.getNameById(username);
        if (details.length === 0) {
          resolve({ code: 204 });
          return;
        }

        if (!isAccessAllowed(resolveIpPolicy(details[0]), clientIp)) {
          resolve({ ...IP_NOT_ALLOWED, ip: clientIp });
          return;
        }

        const info = {};
        info.id = details[0].user_id;
        info.store_id = details[0].store_id;
        info.designation_id = details[0].designation_id;
        info.employee_id = details[0].employee_id;
        info.user_type = details[0].user_type;
        info.name = name[0]?.employee_name;
        info.designation = name[0]?.designation_name;
        info.employee_image = name[0]?.employee_image;

        const token = await jwt.sign(info, "1d");
        resolve({
          code: 200,
          token: token,
          store_id: info.store_id,
          designation_id: info.designation_id,
          employee_id: info.employee_id,
          user_type: info.user_type,
          name: info.name,
          designation: info.designation,
          employee_image: info.employee_image,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * One user's resolved IP policy — `{ exempt, rules, source }`.
   *
   * A missing row is treated as exempt: there is nothing to enforce against,
   * and the token check has already established who the caller is.
   */
  async getIpPolicy(userId) {
    const row = await this.userRepo.getIpPolicy(userId);
    if (!row) return { exempt: true, rules: [], source: "missing" };

    return resolveIpPolicy(row);
  }

  /** Every active login with its policy and its branch's rule, for the admin screen. */
  async getIpRestrictions() {
    const rows = await this.userRepo.getIpRestrictions();
    return (rows || []).map((row) => {
      const policy = normalizeIpPolicy(row.ip_policy) || "branch";
      const effective = resolveIpPolicy(row);
      return {
        ...row,
        ip_policy: policy,
        allowed_ips: parseAllowList(row.allowed_ips),
        branch_enabled: toBoolean(row.branch_enabled, false),
        branch_ips: parseAllowList(row.branch_ips),
        effective,
        is_restricted: !effective.exempt,
        // Read by the previous release's screen during rollout; drop with it.
        allow_outside_access: policy !== "custom",
      };
    });
  }

  /**
   * Replace a user's IP policy.
   *
   * `ipPolicy` is the decision: `branch` (follow their branch's rule),
   * `custom` (their own list, unioned with the branch's) or `unrestricted`.
   * The previous release's boolean is still accepted so the old screen keeps
   * working in the minutes between the backend and frontend deploys.
   *
   * The list is stored under every policy, so moving someone back to
   * `custom` does not mean retyping their addresses. Entries are validated,
   * and `custom` with an empty list is refused, so neither a typo nor an
   * oversight can leave someone unable to sign in from anywhere.
   */
  async updateIpPolicy(userId, allowedIps, ipPolicy) {
    const policy = normalizeIpPolicy(ipPolicy);
    if (!policy) {
      const error = new Error(
        "ip_policy must be one of branch, custom or unrestricted"
      );
      error.name = "ValidationError";
      throw error;
    }

    const { valid, reason, rules } = validateIpPolicy({
      restricted: policy === "custom",
      allowedIps,
    });
    if (!valid) {
      const error = new Error(reason);
      error.name = "ValidationError";
      throw error;
    }

    const value = rules.length === 0 ? null : rules.join(", ");
    await this.userRepo.updateIpPolicy(userId, value, policy);
    return {
      code: 200,
      allowed_ips: rules,
      ip_policy: policy,
      allow_outside_access: policy !== "custom",
    };
  }
}

module.exports = (userRepo, designationRepo, employeeRepo) => {
  return new UserUsecase(userRepo, designationRepo, employeeRepo);
};
