const jwt = require("../services/jwt");
const {
  isAccessAllowed,
  parseAllowList,
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
   * `clientIp` is the address the request came from. When the account has
   * outside access turned off, a login from anywhere but its allowed
   * addresses is refused even though the credentials are correct.
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

        if (!isAccessAllowed(details[0], clientIp)) {
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
   * One user's IP policy, normalized.
   *
   * A missing row is treated as unrestricted — there is nothing to enforce
   * against, and the token check has already established who the caller is.
   */
  async getIpPolicy(userId) {
    const row = await this.userRepo.getIpPolicy(userId);
    if (!row) return { allowed_ips: [], allow_outside_access: true };

    return {
      allowed_ips: parseAllowList(row.allowed_ips),
      allow_outside_access: toBoolean(row.allow_outside_access, true),
    };
  }

  /** Every active login with its IP policy, for the admin screen. */
  async getIpRestrictions() {
    const rows = await this.userRepo.getIpRestrictions();
    return (rows || []).map((row) => {
      const allowOutside = toBoolean(row.allow_outside_access, true);
      return {
        ...row,
        allowed_ips: parseAllowList(row.allowed_ips),
        allow_outside_access: allowOutside,
        is_restricted: !allowOutside,
      };
    });
  }

  /**
   * Replace a user's IP policy.
   *
   * `allowOutsideAccess` is the decision — whether this person may work from
   * anywhere or only from the listed addresses. The list is stored either
   * way, so letting someone out temporarily does not lose the store's
   * addresses.
   *
   * Entries are validated first, and blocking outside access with an empty
   * list is refused, so neither a typo nor an oversight can leave someone
   * unable to sign in from anywhere.
   */
  async updateIpPolicy(userId, allowedIps, allowOutsideAccess) {
    const allowOutside = toBoolean(allowOutsideAccess, true);
    const { valid, reason, rules } = validateIpPolicy({
      allowOutsideAccess: allowOutside,
      allowedIps,
    });

    if (!valid) {
      const error = new Error(reason);
      error.name = "ValidationError";
      throw error;
    }

    const value = rules.length === 0 ? null : rules.join(", ");
    await this.userRepo.updateIpPolicy(userId, value, allowOutside);
    return {
      code: 200,
      allowed_ips: rules,
      allow_outside_access: allowOutside,
    };
  }
}

module.exports = (userRepo, designationRepo, employeeRepo) => {
  return new UserUsecase(userRepo, designationRepo, employeeRepo);
};
